import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../../config/index.js';
import { createLogger } from '../logger.js';

/**
 * Uji penyensoran log. ROADMAP M14 — masking data sensitif di semua log.
 *
 * Penyensoran adalah kontrol keamanan, dan kontrol keamanan yang tidak diuji
 * adalah kontrol yang diyakini ada. Daftar `redact` mudah dipercaya begitu saja:
 * ia terlihat benar, tidak pernah berbunyi ketika salah, dan kegagalannya baru
 * terlihat ketika sandi seseorang sudah ada di agregator log selama enam bulan.
 *
 * Yang ditangkap di sini adalah BARIS YANG BENAR-BENAR DITULIS pino, bukan
 * argumen yang masuk. Uji yang memeriksa argumen akan tetap hijau meski seluruh
 * daftar `redact` dihapus.
 */

function capture(): { log: ReturnType<typeof createLogger>; lines: () => string } {
  const written: string[] = [];

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgres://uji:uji@127.0.0.1:5432/uji',
    REDIS_URL: 'redis://127.0.0.1:6379',
    JWT_ISSUER: 'https://api.kantongz.id',
    JWT_AUDIENCE: 'kantongz-web',
    JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
    JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
    MASTER_KEY: 'rahasia-induk-uji-yang-cukup-panjang',
  });

  const log = createLogger(config, {
    write(chunk: string) {
      written.push(chunk);
    },
  });

  return { log, lines: () => written.join('') };
}

const SANDI = 'sandi-rahasia-yang-tidak-boleh-bocor';
const TOKEN = 'token-rahasia-yang-tidak-boleh-bocor';

describe('bidang tingkat atas', () => {
  it('menyensor sandi', () => {
    const { log, lines } = capture();
    log.info({ password: SANDI }, 'masuk');

    expect(lines()).not.toContain(SANDI);
    expect(lines()).toContain('[REDACTED]');
  });

  it('menyensor sandi baru pada pemulihan', () => {
    const { log, lines } = capture();
    log.info({ newPassword: SANDI }, 'reset');

    expect(lines()).not.toContain(SANDI);
  });

  it('menyensor kode verifikasi', () => {
    const { log, lines } = capture();
    log.info({ code: '482917' }, 'verifikasi');

    expect(lines()).not.toContain('482917');
  });

  it('menyensor tiket', () => {
    const { log, lines } = capture();
    log.info({ ticket: 'tkt_01KZDFHTF2CNCJ86CY5P63FDJ4' }, 'tiket');

    expect(lines()).not.toContain('tkt_01KZDFHTF2CNCJ86CY5P63FDJ4');
  });

  it('menyensor kedua jenis token', () => {
    const { log, lines } = capture();
    log.info({ accessToken: TOKEN, refreshToken: TOKEN }, 'sesi');

    expect(lines()).not.toContain(TOKEN);
  });
});

describe('bidang bersarang', () => {
  /*
   * Badan permintaan masuk sebagai objek. `password` di dalamnya TIDAK
   * tertangkap pola tingkat atas, dan inilah cara sandi paling sering bocor:
   * seseorang mencatat seluruh badan permintaan untuk menelusuri satu bug, lalu
   * lupa menghapusnya.
   */
  it('menyensor sandi di dalam objek', () => {
    const { log, lines } = capture();
    log.info({ body: { email: 'orang@contoh.id', password: SANDI } }, 'permintaan');

    expect(lines()).not.toContain(SANDI);
    /* Email tetap ada — ia bukan rahasia, dan menghapusnya membuat penelusuran
       mustahil. */
    expect(lines()).toContain('orang@contoh.id');
  });

  it('menyensor refresh token di dalam objek', () => {
    const { log, lines } = capture();
    log.info({ tokens: { refreshToken: TOKEN } }, 'rotasi');

    expect(lines()).not.toContain(TOKEN);
  });
});

describe('header permintaan', () => {
  it('menyensor header Authorization', () => {
    const { log, lines } = capture();
    log.info({ req: { headers: { authorization: `Bearer ${TOKEN}` } } }, 'masuk');

    expect(lines()).not.toContain(TOKEN);
  });

  it('menyensor header Cookie', () => {
    const { log, lines } = capture();
    log.info({ req: { headers: { cookie: `kz_rt=${TOKEN}` } } }, 'masuk');

    expect(lines()).not.toContain(TOKEN);
  });
});

describe('bentuk baris', () => {
  it('satu objek JSON per baris', () => {
    const { log, lines } = capture();
    log.info({ a: 1 }, 'satu');
    log.info({ b: 2 }, 'dua');

    const rows = lines().trim().split('\n');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(() => JSON.parse(row) as unknown).not.toThrow();
    }
  });

  /* Tanpa keduanya, log dari sepuluh layanan di satu agregator tidak dapat
     dipisahkan. */
  it('membawa nama layanan dan lingkungan di setiap baris', () => {
    const { log, lines } = capture();
    log.info('apa saja');

    const row = JSON.parse(lines().trim()) as { service?: string; env?: string };
    expect(row.service).toBe('kantongz-api');
    expect(row.env).toBe('test');
  });

  it('menyensor tanpa menghapus bidangnya', () => {
    const { log, lines } = capture();
    log.info({ password: SANDI }, 'masuk');

    const row = JSON.parse(lines().trim()) as { password?: string };
    /* Bidang yang dihapus membuat baris kehilangan bentuknya dan menyulitkan
       penelusuran. Penanda mempertahankan bentuk sambil membuang isinya. */
    expect(row.password).toBe('[REDACTED]');
  });
});
