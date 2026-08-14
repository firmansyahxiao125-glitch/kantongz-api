import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP — RFC 6238, di atas HOTP RFC 4226.
 *
 * ── MENGAPA DITULIS SENDIRI ────────────────────────────────────────────
 *
 * Seluruh algoritmanya adalah HMAC-SHA1 atas satu penghitung 8 byte, ditambah
 * pemotongan dinamis. Node sudah membawa HMAC-nya; yang tersisa dua puluh baris
 * aritmetika. Menambah dependensi untuk itu berarti menambah satu paket yang
 * harus diaudit, diperbarui, dan dipercaya SELAMANYA di jalur masuk — tempat
 * dependensi paling mahal kalau ternyata salah.
 *
 * Dan algoritma yang ditulis sendiri hanya dapat dipercaya kalau diuji
 * terhadap vektor RESMI. Berkas ini diuji dengan vektor RFC 6238 apa adanya —
 * enam waktu, tiga di antaranya melewati batas 32-bit yang menjadi kesalahan
 * implementasi paling umum.
 *
 * ── SHA-1, DAN ITU BUKAN KELALAIAN ─────────────────────────────────────
 *
 * RFC 6238 mengizinkan SHA-256 dan SHA-512, tetapi Google Authenticator,
 * Authy, dan 1Password hanya benar-benar sepakat pada SHA-1. Memilih algoritma
 * yang "lebih kuat" di sini menghasilkan kode yang tidak cocok di aplikasi
 * yang benar-benar dipakai orang.
 *
 * Kekuatan SHA-1 juga bukan yang menjaga TOTP: rahasianya 160 bit acak, kodenya
 * hidup 30 detik, dan percobaannya dibatasi. Yang menjadikan TOTP aman adalah
 * ketiga hal itu, bukan tahan-tabrakan fungsi hash-nya.
 */

/** Langkah waktu RFC 6238. Setiap aplikasi autentikator memakai 30 detik. */
export const STEP_SECONDS = 30;

/** Panjang kode. Enam digit adalah yang dipahami setiap aplikasi. */
export const DIGITS = 6;

/**
 * Toleransi langkah ke belakang dan ke depan.
 *
 * SATU langkah, bukan nol dan bukan tiga. Nol menolak pengguna yang jamnya
 * meleset beberapa detik — dan jam ponsel memang meleset. Tiga memperlebar
 * jendela tebakan menjadi tujuh kode sekaligus tanpa alasan yang sepadan.
 */
export const WINDOW = 1;

/* ── base32, RFC 4648 ─────────────────────────────────────────────────── */

const ALFABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Rahasia dikodekan base32 karena itulah yang dibaca aplikasi autentikator. */
export function base32Encode(buf: Buffer): string {
  let bit = 0;
  let nilai = 0;
  let keluar = '';

  for (const byte of buf) {
    nilai = (nilai << 8) | byte;
    bit += 8;
    while (bit >= 5) {
      keluar += ALFABET[(nilai >>> (bit - 5)) & 31];
      bit -= 5;
    }
  }
  if (bit > 0) keluar += ALFABET[(nilai << (5 - bit)) & 31];

  /* Tanpa '=' padding: aplikasi autentikator menerimanya, dan URI otpauth
     jauh lebih mudah dibaca tanpa itu. */
  return keluar;
}

export function base32Decode(teks: string): Buffer {
  const bersih = teks.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bit = 0;
  let nilai = 0;
  const keluar: number[] = [];

  for (const ch of bersih) {
    const i = ALFABET.indexOf(ch);
    if (i === -1) throw new Error('base32 tidak valid');
    nilai = (nilai << 5) | i;
    bit += 5;
    if (bit >= 8) {
      keluar.push((nilai >>> (bit - 8)) & 255);
      bit -= 8;
    }
  }
  return Buffer.from(keluar);
}

/* ── inti ─────────────────────────────────────────────────────────────── */

/** Rahasia 20 byte — panjang yang direkomendasikan RFC 4226 untuk SHA-1. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * Satu kode untuk satu penghitung. HOTP, RFC 4226 §5.3.
 *
 * Penghitungnya ditulis 8 byte big-endian lewat `BigInt`. Menuliskannya sebagai
 * dua kata 32-bit adalah tempat implementasi paling sering salah, dan salahnya
 * baru muncul pada tahun 2038 — jauh sesudah siapa pun memeriksanya. Vektor
 * RFC dengan T=20000000000 menegakkan justru kasus itu.
 */
export function hotp(secret: string, counter: bigint, digits = DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);

  const mac = createHmac('sha1', base32Decode(secret)).update(buf).digest();

  /* Pemotongan dinamis: empat bit terakhir menunjuk offset. */
  const offset = mac[mac.length - 1]! & 0x0f;
  const kode =
    (((mac[offset]! & 0x7f) << 24) |
      ((mac[offset + 1]! & 0xff) << 16) |
      ((mac[offset + 2]! & 0xff) << 8) |
      (mac[offset + 3]! & 0xff)) %
    10 ** digits;

  return String(kode).padStart(digits, '0');
}

export function totp(secret: string, atMs: number = Date.now(), digits = DIGITS): string {
  return hotp(secret, BigInt(Math.floor(atMs / 1000 / STEP_SECONDS)), digits);
}

/**
 * Memeriksa kode terhadap jendela toleransi.
 *
 * Perbandingannya WAKTU-TETAP. Perbandingan string biasa berhenti pada karakter
 * pertama yang berbeda, dan selisih waktunya — meski kecil — cukup untuk
 * menebak kode digit demi digit ketika penyerang dapat mencoba berkali-kali.
 */
export function verify(secret: string, kode: string, atMs: number = Date.now()): boolean {
  const bersih = kode.replace(/\s/g, '');
  if (!/^\d+$/.test(bersih) || bersih.length !== DIGITS) return false;

  const langkah = Math.floor(atMs / 1000 / STEP_SECONDS);
  const diberi = Buffer.from(bersih);

  let cocok = false;
  for (let d = -WINDOW; d <= WINDOW; d += 1) {
    const harapan = Buffer.from(hotp(secret, BigInt(langkah + d)));
    /* TIDAK keluar lebih awal saat cocok: keluar pada iterasi yang berbeda
       membocorkan langkah mana yang benar lewat waktu eksekusi. */
    if (harapan.length === diberi.length && timingSafeEqual(harapan, diberi)) cocok = true;
  }
  return cocok;
}

/**
 * URI otpauth yang dipindai aplikasi autentikator.
 *
 * Label memuat penerbit DAN akun ("KANTONGZ:nama@contoh.id") karena itulah
 * yang membuat entri dapat dibedakan ketika seseorang memakai beberapa akun
 * pada satu aplikasi. `issuer` diulang sebagai parameter — sebagian aplikasi
 * membaca label, sebagian lagi parameternya.
 */
export function otpauthUri(secret: string, akun: string, penerbit = 'KANTONGZ'): string {
  const label = encodeURIComponent(`${penerbit}:${akun}`);
  const params = new URLSearchParams({
    secret,
    issuer: penerbit,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ── kode pemulihan ───────────────────────────────────────────────────── */

/** Berapa kode pemulihan diterbitkan sekali enrol. */
export const RECOVERY_COUNT = 10;

/**
 * Kode pemulihan sekali pakai.
 *
 * Huruf ambigu DIBUANG dari alfabetnya (0/O, 1/I/L): kode ini disalin tangan
 * dari kertas oleh orang yang sedang panik karena kehilangan ponselnya, dan
 * "apakah ini nol atau O" adalah cara termudah membuat pemulihan gagal pada
 * saat ia paling dibutuhkan.
 */
const ALFABET_PEMULIHAN = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(jumlah = RECOVERY_COUNT): string[] {
  const kode: string[] = [];
  for (let i = 0; i < jumlah; i += 1) {
    const bytes = randomBytes(10);
    let s = '';
    for (const b of bytes) s += ALFABET_PEMULIHAN[b % ALFABET_PEMULIHAN.length];
    /* Dipisah tanda hubung: manusia menyalin sepuluh karakter jauh lebih
       akurat dalam dua kelompok lima. */
    kode.push(`${s.slice(0, 5)}-${s.slice(5, 10)}`);
  }
  return kode;
}

/** Dinormalkan sebelum di-hash supaya spasi dan huruf kecil tidak menggagalkan. */
export function normaliseRecoveryCode(kode: string): string {
  return kode.toUpperCase().replace(/[\s-]/g, '');
}
