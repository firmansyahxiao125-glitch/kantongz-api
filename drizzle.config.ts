import { defineConfig } from 'drizzle-kit';

/**
 * Migrasi berupa SQL yang bisa dibaca manusia. Untuk sistem yang akan diaudit,
 * migrasi yang tidak bisa dibaca adalah beban. M3_SPEC 1.
 *
 * Seluruh evolusi skema HARUS lewat migrasi. Tidak ada push, tidak ada
 * perubahan manual pada basis data.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/platform/db/schema.ts', './src/platform/db/ledger.ts'],
  out: './drizzle',
  strict: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://kantongz:kantongz@localhost:5432/kantongz',
  },
});
