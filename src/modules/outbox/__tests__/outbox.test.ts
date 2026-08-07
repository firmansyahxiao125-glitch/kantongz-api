import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMemoryDatabase } from '../../../platform/db/memory.js';
import type { Database, DbHandle } from '../../../platform/db/client.js';
import { outbox } from '../../../platform/db/schema.js';
import { createLogger } from '../../../platform/observability/logger.js';
import { loadConfig } from '../../../config/index.js';
import { MAX_ATTEMPTS, enqueue, stats } from '../index.js';
import { render, type Mailer } from '../mailer.js';
import { runOnce } from '../worker.js';

/**
 * Uji outbox terhadap PostgreSQL sungguhan.
 *
 * Yang diuji bukan "apakah pesan terkirim" melainkan apa yang terjadi ketika
 * pengiriman GAGAL — karena di situlah antrean pengiriman membuktikan dirinya
 * atau kehilangan pesan diam-diam.
 */

let handle: DbHandle;
let db: Database;

const logger = createLogger(
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgres://uji:uji@127.0.0.1:5432/uji',
    REDIS_URL: 'redis://127.0.0.1:6379',
    JWT_ISSUER: 'https://api.kantongz.id',
    JWT_AUDIENCE: 'kantongz-web',
    JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
    JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
    MASTER_KEY: 'rahasia-induk-uji-yang-cukup-panjang',
  }),
);

/** Pengirim yang dapat dijatuhkan sesuka hati. */
function mailerThat(behaviour: () => void): Mailer & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send: (message) => {
      behaviour();
      sent.push(message.idempotencyKey);
      return Promise.resolve();
    },
  };
}

beforeAll(async () => {
  handle = await createMemoryDatabase();
  db = handle.db;
}, 60_000);

afterAll(async () => {
  await handle.close();
});

function drain(mailer: Mailer): Promise<number> {
  return runOnce({ db, mailer, logger, intervalMs: 0, batchSize: 20 });
}

describe('antrean', () => {
  it('mengirim pesan yang menunggu lalu menandainya', async () => {
    await enqueue(db, 'email.verify', 'verify:tkt_1', { to: 'a@contoh.id', code: '123456' });

    const mailer = mailerThat(() => undefined);
    expect(await drain(mailer)).toBe(1);
    expect(mailer.sent).toEqual(['verify:tkt_1']);

    /* Putaran kedua tidak menemukan apa pun — inilah yang membedakan antrean
       dari daftar yang dibaca berulang. */
    const lagi = mailerThat(() => undefined);
    expect(await drain(lagi)).toBe(0);
    expect((await stats(db)).pending).toBe(0);
  }, 30_000);

  /* Inti idempotensi: pemanggil yang diulang tidak boleh menghasilkan email
     kedua, dan pemeriksaannya harus di basis data — bukan di ingatan pemanggil. */
  it('menolak kunci idempotensi yang sama tanpa melempar', async () => {
    await enqueue(db, 'email.verify', 'verify:tkt_kembar', { to: 'b@contoh.id', code: '111111' });
    await enqueue(db, 'email.verify', 'verify:tkt_kembar', { to: 'b@contoh.id', code: '222222' });

    const mailer = mailerThat(() => undefined);
    expect(await drain(mailer)).toBe(1);
  }, 30_000);

  it('kunci idempotensi diteruskan ke penyedia', async () => {
    await enqueue(db, 'email.reset', 'reset:tkt_2', { to: 'c@contoh.id', code: '333333' });

    const mailer = mailerThat(() => undefined);
    await drain(mailer);
    expect(mailer.sent).toContain('reset:tkt_2');
  }, 30_000);
});

describe('kegagalan', () => {
  it('mencoba ulang lalu memindahkan ke dead letter pada percobaan kelima', async () => {
    await enqueue(db, 'email.verify', 'verify:tkt_gagal', { to: 'd@contoh.id', code: '444444' });

    const jatuh = mailerThat(() => {
      throw new Error('penyedia email menolak: HTTP 500');
    });

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      /* Tidak ada yang terkirim, dan tidak ada yang hilang. */
      expect(await drain(jatuh), `percobaan ${String(i + 1)}`).toBe(0);
    }

    const setelah = await stats(db);
    expect(setelah.deadLettered).toBe(1);

    /* Sesudah dead letter, pesan berhenti diambil — antrean yang tidak pernah
       menyerah akan menghalangi pesan yang masih bisa terkirim. */
    const sehat = mailerThat(() => undefined);
    expect(await drain(sehat)).toBe(0);
  }, 60_000);

  it('pesan yang sehat tetap terkirim meski ada yang dead letter', async () => {
    await enqueue(db, 'email.verify', 'verify:tkt_sehat', { to: 'e@contoh.id', code: '555555' });

    const mailer = mailerThat(() => undefined);
    expect(await drain(mailer)).toBe(1);
  }, 30_000);

  it('pesan galat dipotong sehingga tidak memuat badan permintaan', async () => {
    await enqueue(db, 'email.reset', 'reset:tkt_panjang', { to: 'f@contoh.id', code: '666666' });

    const bocor = mailerThat(() => {
      /* Sebagian penyedia menggemakan kembali permintaannya — dan permintaannya
         memuat kode verifikasi. */
      throw new Error('x'.repeat(500));
    });
    await drain(bocor);

    const rows = await db
      .select({ lastError: outbox.lastError })
      .from(outbox)
      .where(eq(outbox.idempotencyKey, 'reset:tkt_panjang'));

    expect(rows[0]?.lastError?.length).toBeLessThanOrEqual(200);
  }, 30_000);
});

describe('templat', () => {
  it('memuat kode dan tidak memuat satu pun tautan', () => {
    const { subject, text } = render('email.verify', { to: 'g@contoh.id', code: '778899' });

    expect(subject).toContain('KANTONGZ');
    expect(text).toContain('778899');
    /* Email keuangan yang memuat tautan melatih pengguna mengeklik tautan di
       email keuangan, dan pelatihan itulah yang dimanfaatkan phishing. */
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('email sandi-diubah tidak pernah memuat kode', () => {
    const { text } = render('email.password_changed', { to: 'h@contoh.id', name: 'Rina' });
    expect(text).toContain('Rina');
    expect(text).not.toMatch(/\d{6}/);
  });
});
