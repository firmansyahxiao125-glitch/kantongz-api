import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Primitif kriptografi. M3_SPEC §3.1, §7, §7.1, §14.
 *
 * Seluruh kunci datang dari `KeyProvider` — abstraksi yang di produksi didukung
 * KMS dan di pengembangan didukung variabel lingkungan. Tidak ada satu pun kunci
 * yang tertulis di berkas ini.
 */

/**
 * Parameter argon2id. M3_SPEC §3.1 dan §22-11: 64 MiB, t=3, p=1.
 *
 * Ini beban CPU DAN memori, bukan I/O. Konsekuensinya `auth-service` menskala
 * pada CPU, bukan pada jumlah koneksi — dan anggaran p99 400 ms dihitung dengan
 * angka ini di depan mata, bukan sesudahnya.
 */
/**
 * Nilai `Algorithm.Argon2id` dari `@node-rs/argon2`.
 *
 * Ditulis sebagai angka bernama karena enum-nya ambient const, dan
 * `verbatimModuleSyntax` melarang aksesnya. Dibiarkan implisit lewat nilai
 * bawaan pustaka akan menyembunyikan parameter keamanan yang justru harus
 * paling terlihat.
 */
const ARGON2ID = 2;

export const ARGON2 = {
  algorithm: ARGON2ID,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON2);
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hashValue, plain, ARGON2);
  } catch {
    /* Hash yang rusak atau berformat asing bukan alasan membocorkan galat ke
       pemanggil — dari luar ia tidak boleh bisa dibedakan dari sandi salah. */
    return false;
  }
}

/**
 * Hash umpan untuk verifikasi waktu tetap.
 *
 * M3_SPEC §3.1 mewajibkan verifikasi argon2 tetap dijalankan ketika email tidak
 * ada. Tanpa itu, selisih waktu respons memberi tahu penyerang alamat mana yang
 * terdaftar — dan seluruh usaha menyamarkan pesan galat jadi sia-sia.
 *
 * Dihitung sekali saat modul dimuat, bukan tiap permintaan.
 */
let decoyHash: Promise<string> | null = null;

export async function verifyPasswordAgainstDecoy(plain: string): Promise<void> {
  decoyHash ??= argonHash(randomBytes(32).toString('hex'), ARGON2);
  await argonVerify(await decoyHash, plain, ARGON2).catch(() => false);
}

/* ── Kunci ───────────────────────────────────────────────────────────── */

export interface KeyProvider {
  /** Versi kunci HMAC yang aktif untuk seluruh tulisan baru. §7.1 */
  activeHmacVersion: number;
  /** Kunci HMAC menurut versi. Versi lama tetap tersedia untuk pembacaan. */
  hmacKey: (version: number) => Buffer;
  /** Kunci enkripsi kolom, 32 bita. */
  encryptionKey: () => Buffer;
  /** Kunci penanda tangan tiket hantu. §11 */
  ghostKey: () => Buffer;
}

/* ── HMAC berversi ───────────────────────────────────────────────────── */

export interface Hmac {
  digest: Buffer;
  keyVersion: number;
}

/**
 * HMAC deterministik untuk kolom yang harus bisa dicari.
 *
 * Dipakai `users.email_hash`, `devices.device_hash`, dan `audit_log.ip_hash`.
 * Versi kunci disimpan bersama hasilnya — tanpa itu kunci tidak dapat dirotasi
 * sama sekali. §7.1
 */
export function hmacDigest(keys: KeyProvider, value: string): Hmac {
  const version = keys.activeHmacVersion;
  return {
    digest: createHmac('sha256', keys.hmacKey(version)).update(value, 'utf8').digest(),
    keyVersion: version,
  };
}

/** Menghitung ulang dengan versi kunci tertentu — dipakai saat mencocokkan
 *  baris lama yang ditulis sebelum rotasi. */
export function hmacDigestWithVersion(
  keys: KeyProvider,
  value: string,
  version: number,
): Buffer {
  return createHmac('sha256', keys.hmacKey(version)).update(value, 'utf8').digest();
}

/* ── Enkripsi kolom ──────────────────────────────────────────────────── */

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * AES-256-GCM untuk kolom PII. §7.
 *
 * Format tersimpan: `iv ‖ tag ‖ ciphertext`. Nonce acak per baris, sehingga dua
 * baris dengan nilai sama menghasilkan sandi berbeda — itulah sebabnya kolom
 * terenkripsi tidak bisa dicari dan `emailHash` harus ada terpisah.
 */
export function encryptColumn(keys: KeyProvider, plain: string): Buffer {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keys.encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decryptColumn(keys: KeyProvider, stored: Buffer): string {
  const iv = stored.subarray(0, GCM_IV_BYTES);
  const tag = stored.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const body = stored.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', keys.encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/* ── Nilai acak ──────────────────────────────────────────────────────── */

/** Token refresh: 256 bita acak, buram. BUKAN JWT — §4.1. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Kode verifikasi enam digit dari CSPRNG, bukan `Math.random`. §12 */
export function verificationCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String(randomInt(0, 10));
  return out;
}

export function sha256(value: string | Buffer): Buffer {
  return createHmac('sha256', Buffer.alloc(0)).update(value).digest();
}

/** Perbandingan waktu tetap untuk nilai rahasia berukuran sama. */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ── Tiket hantu ─────────────────────────────────────────────────────── */

/**
 * Tiket untuk email yang tidak terdaftar. §11.
 *
 * TIDAK PERNAH menyentuh basis data. Bentuknya tidak bisa dibedakan dari tiket
 * sungguhan; saat ditukar ia dikenali lalu ditolak.
 *
 * Dua alasan tidak menuliskannya: `tickets.user_id` bersifat NOT NULL dan tiket
 * hantu memang tidak punya pemilik, dan menulis baris untuk permintaan yang
 * tidak sah membuka pengisian tabel oleh siapa pun tanpa satu akun pun.
 */
export function issueGhostTicket(keys: KeyProvider): string {
  const nonce = randomBytes(16);
  const mac = createHmac('sha256', keys.ghostKey()).update(nonce).digest();
  return Buffer.concat([nonce, mac]).toString('base64url');
}

export function isGhostTicket(keys: KeyProvider, ticket: string): boolean {
  let raw: Buffer;
  try {
    raw = Buffer.from(ticket, 'base64url');
  } catch {
    return false;
  }
  if (raw.length !== 16 + 32) return false;

  const nonce = raw.subarray(0, 16);
  const mac = raw.subarray(16);
  const expected = createHmac('sha256', keys.ghostKey()).update(nonce).digest();
  return constantTimeEqual(mac, expected);
}
