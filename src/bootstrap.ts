import type { Config } from './config/index.js';
import { buildServer } from './http/server.js';
import type { App } from './http/types.js';
import type { DbHandle } from './platform/db/client.js';
import { createLogger, type Logger } from './platform/observability/logger.js';
import type { RedisHandle } from './platform/redis/client.js';
import { registerAuth, type DeliverCode } from './modules/auth/wiring.js';
import { registerLedger } from './modules/ledger/wiring.js';
import { registerInsight } from './modules/insight/wiring.js';
import { registerAssistant } from './modules/assistant/wiring.js';
import { registerReceipt } from './modules/receipt/wiring.js';
import type { ReceiptReader } from './modules/receipt/reader.js';
import { seedSystemCategories } from './modules/ledger/seed.js';
import { createHttpMailer, type Mailer } from './modules/outbox/mailer.js';
import { createSmtpMailer } from './modules/outbox/smtp.js';
import { startWorker, type WorkerHandle } from './modules/outbox/worker.js';

/**
 * Perakitan dan siklus hidup proses.
 *
 * Dipisahkan dari titik masuk supaya entri produksi dan entri pengembangan
 * merakit aplikasi yang SAMA PERSIS — hanya sumber basis data dan Redis-nya
 * yang berbeda. Dua fungsi perakitan yang berjalan sendiri-sendiri akan
 * menyimpang, dan yang menyimpang selalu yang jarang dijalankan.
 */

export const VERSION = '0.1.0';

export interface Runtime {
  app: App;
  logger: Logger;
  outbox: WorkerHandle;
  /** Pekerja OCR memegang instans WASM; ia dilepas saat penutupan. */
  receipt: ReceiptReader;
}

/**
 * Penyedia email, atau pencatat kalau kredensialnya belum ada.
 *
 * Mode catat-saja BUKAN pengiriman palsu: pesan tetap melewati outbox, tetap
 * ditandai terkirim, dan tetap terlihat di `/readyz`. Yang tidak terjadi hanya
 * langkah terakhirnya — dan itu jujur terhadap keadaan, sebab tanpa kredensial
 * memang tidak ada yang bisa berangkat.
 */
function mailerFor(config: Config, logger: Logger): Mailer {
  /*
   * URUTANNYA ADALAH KEBIJAKAN:
   *
   *   1. SMTP — BAWAAN. Mailpit menyediakannya lokal tanpa akun; Gmail
   *      menerimanya dengan sandi aplikasi. Tidak ada langganan yang dibayar
   *      untuk mengirim satu email verifikasi.
   *   2. Penyedia HTTP — adaptor OPSIONAL, hanya bila sengaja dipasang.
   *   3. Catat-saja — selalu ada, dan mengatakan dirinya di log saat boot.
   */
  if (config.SMTP_HOST) {
    logger.info({ host: config.SMTP_HOST, port: config.SMTP_PORT }, 'email lewat SMTP');
    return createSmtpMailer({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      from: config.MAIL_FROM,
      user: config.SMTP_USER,
      password: config.SMTP_PASSWORD,
      secure: config.SMTP_SECURE,
      timeoutMs: config.SMTP_TIMEOUT_MS,
    });
  }

  if (config.MAIL_ENDPOINT && config.MAIL_API_KEY) {
    logger.info('email lewat penyedia HTTP');
    return createHttpMailer({
      endpoint: config.MAIL_ENDPOINT,
      apiKey: config.MAIL_API_KEY,
      from: config.MAIL_FROM,
    });
  }

  logger.warn(
    'SMTP_HOST belum diisi — pekerja outbox berjalan dalam mode catat-saja, tidak ada email yang berangkat',
  );

  return {
    send: (message) => {
      /* Subjek dan kunci idempotensi saja. Badan pesan memuat kodenya. */
      logger.info(
        { subject: message.subject, idempotencyKey: message.idempotencyKey },
        'email tidak dikirim (mode catat-saja)',
      );
      return Promise.resolve();
    },
  };
}

export async function bootstrap(
  config: Config,
  db: DbHandle,
  redis: RedisHandle,
  /* Diteruskan HANYA oleh entri mandiri. Produksi memakai bawaan, yang tidak
     pernah mencatat kodenya di mana pun. */
  deliverCode?: DeliverCode,
): Promise<Runtime> {
  const logger = createLogger(config);

  const app = buildServer({ config, logger, db, redis, version: VERSION });
  await registerAuth(app, { config, db: db.db, redis: redis.redis, logger }, deliverCode);
  await registerLedger(app, { config, db: db.db });
  await registerInsight(app, { config, db: db.db });
  await registerAssistant(app, { config, db: db.db, logger });
  const receipt = await registerReceipt(app, { config, logger });

  /* Kategori bawaan ditanam saat boot, bukan lewat migrasi: migrasi menjalankan
     SQL, dan daftar ini hidup di TypeScript tempat ia dibaca dan diubah. */
  const seeded = await seedSystemCategories(db.db);
  if (seeded > 0) logger.info({ seeded }, 'kategori bawaan ditanam');

  /* Pekerja outbox hidup di dalam proses API. `FOR UPDATE SKIP LOCKED` membuat
     sepuluh instans aman menjalankannya bersamaan, jadi tidak ada alasan
     menambah satu proses lagi untuk disebarkan dan dipantau. */
  const outbox = startWorker({
    db: db.db,
    mailer: mailerFor(config, logger),
    logger,
    intervalMs: config.OUTBOX_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
  });

  return { app, logger, outbox, receipt };
}

/**
 * Menjalankan sampai sinyal berhenti datang.
 *
 * Penutupan tertib bukan kerapian. Proses yang dibunuh di tengah transaksi
 * meninggalkan koneksi menggantung sampai server basis data menyapunya, dan
 * penyebaran bergulir yang mengganti sepuluh instans akan meninggalkan sepuluh
 * koneksi mati sekaligus.
 */
export async function serve(
  runtime: Runtime,
  config: Config,
  closers: (() => Promise<void>)[],
): Promise<void> {
  const { app, logger } = runtime;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    /* Sinyal kedua saat penutupan sedang berjalan diabaikan. Menjalankan
       penutupan dua kali menutup koneksi yang sedang dipakai penutupan pertama. */
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'penutupan dimulai');

    try {
      /* Urutannya: berhenti menerima permintaan baru, selesaikan yang berjalan,
         BARU tutup dependensi. Membalik urutan ini membuat permintaan terakhir
         gagal justru karena kita sedang rapi-rapi. */
      /* Pekerja dihentikan SEBELUM koneksi ditutup: putaran yang sedang
         berjalan memegang transaksi, dan menutup pool di bawahnya membuat
         pesan yang sudah terkirim tidak pernah tertandai. */
      runtime.outbox.stop();
      await app.close();
      await runtime.receipt.close();
      await Promise.allSettled(closers.map((close) => close()));
      logger.info('penutupan selesai');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'penutupan gagal');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'promise ditolak tanpa penangan');
    void shutdown('unhandledRejection');
  });

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, host: config.HOST, version: VERSION }, 'siap menerima');
}

/** Kegagalan boot terjadi sebelum logger ada. `console` di sini disengaja dan
 *  satu-satunya di seluruh basis kode. */
export function reportBootFailure(error: unknown): never {
  console.error('gagal memulai:', error instanceof Error ? error.message : error);
  process.exit(1);
}
