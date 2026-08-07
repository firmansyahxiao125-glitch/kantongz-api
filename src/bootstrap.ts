import type { Config } from './config/index.js';
import { buildServer } from './http/server.js';
import type { App } from './http/types.js';
import type { DbHandle } from './platform/db/client.js';
import { createLogger, type Logger } from './platform/observability/logger.js';
import type { RedisHandle } from './platform/redis/client.js';
import { registerAuth, type DeliverCode } from './modules/auth/wiring.js';
import { registerLedger } from './modules/ledger/wiring.js';
import { seedSystemCategories } from './modules/ledger/seed.js';

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

  /* Kategori bawaan ditanam saat boot, bukan lewat migrasi: migrasi menjalankan
     SQL, dan daftar ini hidup di TypeScript tempat ia dibaca dan diubah. */
  const seeded = await seedSystemCategories(db.db);
  if (seeded > 0) logger.info({ seeded }, 'kategori bawaan ditanam');

  return { app, logger };
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
      await app.close();
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
