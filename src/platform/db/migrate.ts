import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { loadConfig } from '../../config/index.js';
import { createDatabase } from './client.js';

/**
 * Penerap migrasi.
 *
 * Dijalankan sebagai proses terpisah sebelum layanan dimulai, bukan dari dalam
 * `src/index.ts`. Alasannya: penyebaran bergulir menjalankan banyak instans
 * sekaligus, dan sepuluh instans yang masing-masing menerapkan migrasi saat
 * boot akan berlomba di atas tabel yang sama.
 *
 * Drizzle mengambil kunci tingkat basis data selama penerapan, jadi menjalankan
 * ini dua kali aman — yang kedua menunggu lalu menemukan tidak ada yang perlu
 * dikerjakan.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const handle = createDatabase(config);

  try {
    await migrate(handle.db, { migrationsFolder: './drizzle' });
    process.stdout.write('migrasi diterapkan\n');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`migrasi gagal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
