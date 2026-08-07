import { bootstrap, reportBootFailure, serve } from './bootstrap.js';
import { loadConfig } from './config/index.js';
import { createDatabase } from './platform/db/client.js';
import { createRedis } from './platform/redis/client.js';

/**
 * Titik masuk produksi.
 *
 * Konfigurasi divalidasi sebelum apa pun dibuat: proses yang gagal boot karena
 * satu variabel hilang jauh lebih baik daripada proses yang berjalan lalu jatuh
 * pada permintaan pertama yang menyentuh variabel itu.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const db = createDatabase(config);
  const redis = createRedis(config);

  await serve(await bootstrap(config, db, redis), config, [
    () => db.close(),
    () => redis.close(),
  ]);
}

main().catch(reportBootFailure);
