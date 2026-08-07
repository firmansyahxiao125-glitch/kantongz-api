import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Database, DbHandle } from './client.js';

/**
 * PostgreSQL dalam proses.
 *
 * PGlite adalah PostgreSQL yang dikompilasi ke WebAssembly — parser, perencana,
 * dan penegakan batasan yang sama, termasuk CHECK dan indeks unik parsial yang
 * diandalkan buku besar. Yang tidak ada hanyalah proses server terpisah.
 *
 * Dipakai untuk pengujian integrasi dan untuk `dev:standalone`, yang membuat
 * seluruh backend dapat dijalankan tanpa Docker. BUKAN untuk produksi: datanya
 * hidup di memori proses dan hilang saat proses berakhir.
 */

const BREAKPOINT = '--> statement-breakpoint';

export async function createMemoryDatabase(migrationsDir = 'drizzle'): Promise<DbHandle> {
  const pg = new PGlite();
  const dir = join(process.cwd(), migrationsDir);

  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    for (const statement of readFileSync(join(dir, file), 'utf8').split(BREAKPOINT)) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await pg.exec(trimmed);
    }
  }

  return {
    db: drizzle(pg) as unknown as Database,
    /* `sql` dipakai `pingDatabase` untuk `SELECT 1`. Bentuk tag-nya sama, jadi
       pemeriksaan kesehatan berjalan apa adanya tanpa cabang khusus. */
    sql: ((strings: TemplateStringsArray) =>
      pg.query(strings.join(''))) as unknown as DbHandle['sql'],
    close: () => pg.close(),
  };
}
