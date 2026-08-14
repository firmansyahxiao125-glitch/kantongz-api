import { describe, expect, it } from 'vitest';

import {
  DIGITS,
  STEP_SECONDS,
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateSecret,
  hotp,
  normaliseRecoveryCode,
  otpauthUri,
  totp,
  verify,
} from '../totp.js';

/**
 * TOTP diuji terhadap vektor RESMI, bukan terhadap dirinya sendiri.
 *
 * Algoritma kriptografi yang ditulis sendiri dan diuji dengan keluarannya
 * sendiri hanya membuktikan bahwa ia konsisten — termasuk konsisten salah.
 * Satu-satunya bukti yang berarti adalah vektor dari spesifikasinya.
 *
 * Vektor di bawah disalin apa adanya dari RFC 6238 Lampiran B (SHA-1).
 * Rahasianya ASCII "12345678901234567890", dikodekan base32.
 */

/* "12345678901234567890" -> base32 */
const SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('vektor resmi RFC 6238', () => {
  /*
   * Tiga vektor terakhir MELEWATI batas 32-bit, dan itu bukan kebetulan.
   * Penghitung TOTP ditulis 8 byte; implementasi yang memakai aritmetika
   * 32-bit lulus tiga vektor pertama lalu diam-diam salah mulai tahun 2038.
   */
  const VEKTOR: [number, string][] = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ];

  for (const [detik, harapan] of VEKTOR) {
    it(`T=${String(detik)} menghasilkan ${harapan}`, () => {
      const counter = BigInt(Math.floor(detik / STEP_SECONDS));
      expect(hotp(SECRET, counter, 8)).toBe(harapan);
    });
  }

  it('enam digit adalah enam digit terakhir dari vektor delapan digit', () => {
    /* Aplikasi autentikator memakai enam digit; RFC menerbitkan delapan.
       Keduanya berasal dari angka yang sama. */
    expect(totp(SECRET, 59_000)).toBe('287082');
    expect(totp(SECRET, 1_111_111_109_000)).toBe('081804');
  });
});

describe('base32', () => {
  it('bolak-balik tanpa kehilangan byte', () => {
    for (const teks of ['a', 'ab', 'abc', 'abcd', 'abcde', '12345678901234567890']) {
      const buf = Buffer.from(teks, 'ascii');
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it('menerima huruf kecil dan padding, sebab manusia menempelkannya begitu', () => {
    const asli = base32Encode(Buffer.from('halo dunia', 'ascii'));
    expect(base32Decode(asli.toLowerCase()).toString('ascii')).toBe('halo dunia');
    expect(base32Decode(`${asli}====`).toString('ascii')).toBe('halo dunia');
  });

  it('menolak karakter di luar alfabet', () => {
    expect(() => base32Decode('ABC!')).toThrow();
  });
});

describe('verifikasi', () => {
  const now = 1_700_000_000_000;

  it('menerima kode saat ini', () => {
    expect(verify(SECRET, totp(SECRET, now), now)).toBe(true);
  });

  /*
   * Jam ponsel MELESET, dan itu keadaan normal — bukan serangan. Menolak
   * pengguna yang jamnya bergeser dua puluh detik membuat 2FA terasa rusak,
   * dan fitur keamanan yang terasa rusak akan dimatikan.
   */
  it('memaafkan pergeseran jam satu langkah ke dua arah', () => {
    const satuLangkah = STEP_SECONDS * 1000;
    expect(verify(SECRET, totp(SECRET, now - satuLangkah), now)).toBe(true);
    expect(verify(SECRET, totp(SECRET, now + satuLangkah), now)).toBe(true);
  });

  it('menolak di luar jendela', () => {
    const duaLangkah = STEP_SECONDS * 2000;
    expect(verify(SECRET, totp(SECRET, now - duaLangkah), now)).toBe(false);
    expect(verify(SECRET, totp(SECRET, now + duaLangkah), now)).toBe(false);
  });

  it('menolak bentuk yang tidak mungkin tanpa menghitung apa pun', () => {
    expect(verify(SECRET, '', now)).toBe(false);
    expect(verify(SECRET, 'abcdef', now)).toBe(false);
    expect(verify(SECRET, '12345', now)).toBe(false);
    expect(verify(SECRET, '1234567', now)).toBe(false);
  });

  it('menerima kode yang disalin dengan spasi', () => {
    const kode = totp(SECRET, now);
    expect(verify(SECRET, `${kode.slice(0, 3)} ${kode.slice(3)}`, now)).toBe(true);
  });
});

describe('rahasia dan URI', () => {
  it('rahasia acak dan panjangnya benar', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
    /* 20 byte -> 32 karakter base32. */
    expect(a).toHaveLength(32);
    expect(base32Decode(a)).toHaveLength(20);
  });

  it('URI otpauth memuat yang dibaca aplikasi autentikator', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'nadia@contoh.id');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=KANTONGZ');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain(`digits=${String(DIGITS)}`);
    expect(uri).toContain(`period=${String(STEP_SECONDS)}`);
    /* Label wajib memuat akun, kalau tidak dua akun tampil identik. */
    expect(decodeURIComponent(uri.split('?')[0] ?? '')).toContain('nadia@contoh.id');
  });
});

describe('kode pemulihan', () => {
  it('sepuluh kode, seluruhnya berbeda', () => {
    const kode = generateRecoveryCodes();
    expect(kode).toHaveLength(10);
    expect(new Set(kode).size).toBe(10);
  });

  /*
   * Kode ini disalin TANGAN dari kertas oleh orang yang baru kehilangan
   * ponselnya. "Apakah ini nol atau huruf O" adalah cara termudah membuat
   * pemulihan gagal tepat ketika ia paling dibutuhkan.
   */
  it('tidak pernah memuat huruf yang ambigu saat disalin tangan', () => {
    for (const k of generateRecoveryCodes(50)) {
      expect(k).not.toMatch(/[01OIL]/);
    }
  });

  it('normalisasi memaafkan huruf kecil, spasi, dan tanda hubung', () => {
    const kode = generateRecoveryCodes(1)[0] ?? '';
    const acak = ` ${kode.toLowerCase().replace('-', ' - ')} `;
    expect(normaliseRecoveryCode(acak)).toBe(normaliseRecoveryCode(kode));
    expect(normaliseRecoveryCode(kode)).toHaveLength(10);
  });
});
