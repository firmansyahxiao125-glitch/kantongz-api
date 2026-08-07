import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { bootstrap, reportBootFailure, serve } from './bootstrap.js';
import { loadConfig } from './config/index.js';
import { createMemoryDatabase } from './platform/db/memory.js';
import { createMemoryRedis } from './platform/redis/memory.js';

/**
 * Titik masuk pengembangan tanpa infrastruktur.
 *
 * Merakit aplikasi yang SAMA dengan produksi — rute, aturan, migrasi, dan
 * kategori bawaan yang sama — di atas PostgreSQL dalam proses (PGlite) dan Redis
 * dalam memori. Gunanya satu: frontend dapat dikembangkan dan alur ujung ke
 * ujung dapat diperiksa tanpa menunggu Docker.
 *
 * BUKAN untuk produksi, dan sengaja dibuat sulit disalahgunakan:
 * — berkas terpisah, jadi tidak ada variabel lingkungan yang bisa mengubah
 *   entri produksi menjadi mode ini karena salah ketik;
 * — data hilang saat proses berakhir;
 * — kunci penandatangan dibangkitkan baru setiap kali dijalankan, jadi token
 *   dari sesi sebelumnya langsung tidak berlaku.
 */
async function main(): Promise<void> {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'development',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
    DATABASE_URL: 'postgres://memory/kantongz',
    REDIS_URL: 'redis://memory:6379',
    JWT_ISSUER: process.env.JWT_ISSUER ?? 'https://api.kantongz.id',
    JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'kantongz-web',
    JWT_PRIVATE_KEY: pair.privateKey,
    JWT_PUBLIC_KEY: pair.publicKey,
    MASTER_KEY: randomBytes(32).toString('base64url'),
    HMAC_KEY_VERSION: '1',
  });

  const db = await createMemoryDatabase();
  const redis = createMemoryRedis();

  /*
   * Kode verifikasi dicetak ke terminal.
   *
   * Tanpa ini tidak ada yang bisa menyelesaikan pendaftaran secara lokal —
   * tidak ada kotak masuk, dan logger sengaja menyensor `code` di produksi.
   * Ditulis langsung ke stdout, bukan lewat logger, supaya penyensoran itu
   * tetap utuh dan pengecualiannya terlihat jelas di berkas ini saja.
   */
  const runtime = await bootstrap(config, db, redis, (to, purpose, code) => {
    process.stdout.write(`\n  ✉  ${purpose.toUpperCase()} ${to} → kode ${code}\n\n`);
    return Promise.resolve();
  });

  runtime.logger.warn(
    'MODE MANDIRI — PostgreSQL dalam proses, Redis dalam memori. Data hilang saat proses berhenti.',
  );

  await serve(runtime, config, [() => db.close(), () => redis.close()]);
}

main().catch(reportBootFailure);
