import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { Config } from '../../config/index.js';

/**
 * Koneksi PostgreSQL.
 *
 * Satu pool untuk seumur hidup proses. Pool yang dibuat per permintaan
 * menghabiskan slot koneksi server jauh sebelum lalu lintasnya berarti.
 *
 * `prepare: false` diperlukan karena penyebaran akan berada di belakang
 * pooler dalam mode transaksi, dan pernyataan yang disiapkan tidak selamat
 * melewati batas transaksi di sana.
 */
export type Database = PostgresJsDatabase<Record<string, never>>;

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export function createDatabase(config: Config): DbHandle {
  const sql = postgres(config.DATABASE_URL, {
    max: config.DATABASE_POOL_MAX,
    prepare: false,
    onnotice: () => {},
  });

  return {
    db: drizzle(sql),
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Dipakai `/readyz`. Sengaja sesederhana mungkin — yang diuji adalah apakah
 *  koneksi hidup, bukan apakah kuerinya benar. */
export async function pingDatabase(handle: DbHandle): Promise<void> {
  await handle.sql`SELECT 1`;
}
