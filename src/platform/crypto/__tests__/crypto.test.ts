import { describe, expect, it } from 'vitest';

import {
  constantTimeEqual,
  decryptColumn,
  encryptColumn,
  hashPassword,
  hmacDigest,
  hmacDigestWithVersion,
  isGhostTicket,
  issueGhostTicket,
  randomToken,
  verificationCode,
  verifyPassword,
} from '../index.js';
import { createKeyProvider } from '../keys.js';

const keys = createKeyProvider({ master: 'rahasia-uji', activeHmacVersion: 1 });

describe('sandi', () => {
  it('memverifikasi sandi yang benar', async () => {
    const h = await hashPassword('kantongz-uji-sandi');
    expect(await verifyPassword(h, 'kantongz-uji-sandi')).toBe(true);
  }, 30_000);

  it('menolak sandi yang salah', async () => {
    const h = await hashPassword('kantongz-uji-sandi');
    expect(await verifyPassword(h, 'sandi-lain')).toBe(false);
  }, 30_000);

  it('menghasilkan hash berbeda untuk sandi yang sama (salt acak)', async () => {
    const [a, b] = await Promise.all([hashPassword('sama'), hashPassword('sama')]);
    expect(a).not.toBe(b);
  }, 30_000);

  it('tidak melempar pada hash yang rusak — dari luar sama dengan sandi salah', async () => {
    expect(await verifyPassword('bukan-hash-argon2', 'apa pun')).toBe(false);
  });
});

describe('HMAC berversi', () => {
  it('deterministik untuk masukan yang sama', () => {
    const a = hmacDigest(keys, 'orang@contoh.id');
    const b = hmacDigest(keys, 'orang@contoh.id');
    expect(a.digest.equals(b.digest)).toBe(true);
    expect(a.keyVersion).toBe(1);
  });

  it('berbeda untuk masukan berbeda', () => {
    const a = hmacDigest(keys, 'satu@contoh.id');
    const b = hmacDigest(keys, 'dua@contoh.id');
    expect(a.digest.equals(b.digest)).toBe(false);
  });

  /* Inti temuan audit HIGH-6: tanpa versi, kunci tidak dapat dirotasi. */
  it('menghasilkan digest berbeda per versi kunci', () => {
    const v1 = hmacDigestWithVersion(keys, 'orang@contoh.id', 1);
    const v2 = hmacDigestWithVersion(keys, 'orang@contoh.id', 2);
    expect(v1.equals(v2)).toBe(false);
  });

  it('masih bisa membaca versi lama setelah rotasi', () => {
    const sebelum = hmacDigestWithVersion(keys, 'orang@contoh.id', 1);
    const setelahRotasi = createKeyProvider({ master: 'rahasia-uji', activeHmacVersion: 2 });
    expect(hmacDigestWithVersion(setelahRotasi, 'orang@contoh.id', 1).equals(sebelum)).toBe(true);
    expect(setelahRotasi.activeHmacVersion).toBe(2);
  });
});

describe('enkripsi kolom', () => {
  it('pulang-pergi tanpa kehilangan', () => {
    const asli = 'Firman Syah — ç, é, 日本語';
    expect(decryptColumn(keys, encryptColumn(keys, asli))).toBe(asli);
  });

  /* Inilah sebabnya kolom terenkripsi tidak bisa dicari, dan sebabnya
     `email_hash` harus ada terpisah. §7 */
  it('menghasilkan sandi berbeda untuk teks yang sama', () => {
    const a = encryptColumn(keys, 'sama@contoh.id');
    const b = encryptColumn(keys, 'sama@contoh.id');
    expect(a.equals(b)).toBe(false);
  });

  it('menolak sandi yang dirusak (tag GCM)', () => {
    const sandi = encryptColumn(keys, 'rahasia');
    const akhir = sandi.length - 1;
    sandi.writeUInt8(sandi.readUInt8(akhir) ^ 0xff, akhir);
    expect(() => decryptColumn(keys, sandi)).toThrow();
  });
});

describe('nilai acak', () => {
  it('token refresh 256 bita dan unik', () => {
    const a = randomToken();
    const b = randomToken();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it('kode verifikasi enam digit', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(verificationCode()).toMatch(/^\d{6}$/);
    }
  });
});

describe('tiket hantu', () => {
  it('dikenali oleh kunci yang menerbitkannya', () => {
    expect(isGhostTicket(keys, issueGhostTicket(keys))).toBe(true);
  });

  it('setiap penerbitan berbeda', () => {
    expect(issueGhostTicket(keys)).not.toBe(issueGhostTicket(keys));
  });

  it('menolak tiket yang bukan hantu', () => {
    expect(isGhostTicket(keys, 'tiket-sungguhan-01J8')).toBe(false);
    expect(isGhostTicket(keys, '')).toBe(false);
  });

  it('menolak hantu dari kunci lain', () => {
    const lain = createKeyProvider({ master: 'rahasia-berbeda', activeHmacVersion: 1 });
    expect(isGhostTicket(keys, issueGhostTicket(lain))).toBe(false);
  });
});

describe('perbandingan waktu tetap', () => {
  it('benar untuk nilai sama, salah untuk berbeda dan panjang berbeda', () => {
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });
});
