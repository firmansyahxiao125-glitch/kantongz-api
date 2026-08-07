import { loadConfig } from './config/index.js';
import { createDatabase } from './platform/db/client.js';
import { createLogger } from './platform/observability/logger.js';
import { createRedis } from './platform/redis/client.js';
import { buildServer } from './http/server.js';
import { registerAuth } from './modules/auth/wiring.js';
import { registerLedger } from './modules/ledger/wiring.js';
import { seedSystemCategories } from './modules/ledger/seed.js';

const VERSION = '0.1.0';

/**
 * Titik masuk proses.
 *
 * Dua hal yang membuatnya layak produksi: konfigurasi divalidasi sebelum apa
 * pun dibuat, dan penutupan berlangsung tertib.
 *
 * Penutupan tertib bukan kerapian. Proses yang dibunuh di tengah transaksi
 * meninggalkan koneksi menggantung sampai server basis data menyapunya, dan
 * penyebaran bergulir yang mengganti sepuluh instans akan meninggalkan sepuluh
 * koneksi mati sekaligus.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const db = createDatabase(config);
  const redis = createRedis(config);

  const app = buildServer({ config, logger, db, redis, version: VERSION });
  await registerAuth(app, { config, db: db.db, redis: redis.redis, logger });
  await registerLedger(app, { config, db: db.db });

  /* Kategori bawaan ditanam saat boot, bukan lewat migrasi: migrasi menjalankan
     SQL, dan daftar ini hidup di TypeScript tempat ia dibaca dan diubah. */
  const seeded = await seedSystemCategories(db.db);
  if (seeded > 0) logger.info({ seeded }, 'kategori bawaan ditanam');

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
      await Promise.allSettled([db.close(), redis.close()]);
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

main().catch((error: unknown) => {
  /* Kegagalan boot terjadi sebelum logger ada. `console` di sini disengaja dan
     satu-satunya di seluruh basis kode. */

  console.error('gagal memulai:', error instanceof Error ? error.message : error);
  process.exit(1);
});
