import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Redis } from 'ioredis';

import { loadConfig } from '../../../config/index.js';
import type { Database } from '../../../platform/db/client.js';
import { createLogger } from '../../../platform/observability/logger.js';
import { buildServer } from '../../../http/server.js';
import { registerAuthRoutes } from '../routes.js';
import { buildAuthDeps } from '../wiring.js';
import type { App } from '../../../http/types.js';

/**
 * Perkakas uji integrasi.
 *
 * PostgreSQL yang dipakai di sini SUNGGUHAN — PGlite adalah PostgreSQL yang
 * dikompilasi ke WASM, dengan parser, perencana, dan penegakan batasan yang
 * sama. Yang ditiru hanya Redis, karena yang diuji adalah aturan autentikasi,
 * bukan implementasi penyimpanan kunci-nilai.
 */

const BREAKPOINT = '--> statement-breakpoint';

const ISSUER = { issuer: 'https://api.kantongz.id', audience: 'kantongz-mobile' } as const;

/**
 * Redis dalam memori.
 *
 * Hanya perintah yang benar-benar dipakai. Menirunya lebih luas berarti menguji
 * tiruan itu sendiri, bukan kode yang memakainya.
 */
export class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  /** Menyalakan ini membuat setiap perintah melempar — dipakai membuktikan
   *  perilaku degradasi §19.5. */
  failing = false;

  private guard(): void {
    if (this.failing) throw new Error('redis tidak tersedia');
  }

  private live(key: string): { value: string; expiresAt: number | null } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  get(key: string): Promise<string | null> {
    this.guard();
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  set(key: string, value: string, mode?: string, ttl?: number): Promise<'OK'> {
    this.guard();
    const expiresAt = mode === 'PX' && typeof ttl === 'number' ? Date.now() + ttl : null;
    this.store.set(key, { value, expiresAt });
    return Promise.resolve('OK');
  }

  incr(key: string): Promise<number> {
    this.guard();
    const current = Number(this.live(key)?.value ?? '0') + 1;
    this.store.set(key, { value: String(current), expiresAt: this.live(key)?.expiresAt ?? null });
    return Promise.resolve(current);
  }

  expire(key: string, seconds: number): Promise<number> {
    this.guard();
    const entry = this.live(key);
    if (!entry) return Promise.resolve(0);
    entry.expiresAt = Date.now() + seconds * 1000;
    return Promise.resolve(1);
  }

  pttl(key: string): Promise<number> {
    this.guard();
    const entry = this.live(key);
    if (!entry) return Promise.resolve(-2);
    return Promise.resolve(entry.expiresAt === null ? -1 : entry.expiresAt - Date.now());
  }

  ttl(key: string): Promise<number> {
    this.guard();
    return this.pttl(key).then((ms) => (ms > 0 ? Math.ceil(ms / 1000) : ms));
  }

  del(...keys: string[]): Promise<number> {
    this.guard();
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return Promise.resolve(removed);
  }

  /** Memaksa entri grace kedaluwarsa tanpa menunggu waktu nyata. */
  forget(prefix: string): void {
    for (const key of [...this.store.keys()]) if (key.startsWith(prefix)) this.store.delete(key);
  }
}

export interface Delivery {
  to: string;
  purpose: string;
  code: string;
}

export interface Harness {
  app: App;
  db: Database;
  redis: FakeRedis;
  /** Kode terakhir yang "dikirim" — menggantikan kotak masuk. */
  lastCode: () => Delivery | null;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const pg = new PGlite();

  for (const file of readdirSync(join(process.cwd(), 'drizzle'))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(process.cwd(), 'drizzle', file), 'utf8');
    for (const statement of sql.split(BREAKPOINT)) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await pg.exec(trimmed);
    }
  }

  const db = drizzle(pg) as unknown as Database;
  const redis = new FakeRedis();

  let delivered: Delivery | null = null;

  /* Konfigurasi dilewatkan melalui validator sungguhan, bukan objek literal —
     supaya perubahan pada skema config ikut terdeteksi di sini. */
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PORT: '3000',
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://uji:uji@127.0.0.1:5432/uji',
    DATABASE_POOL_MAX: '1',
    REDIS_URL: 'redis://127.0.0.1:6379',
    JWT_ISSUER: ISSUER.issuer,
    JWT_AUDIENCE: ISSUER.audience,
    JWT_PRIVATE_KEY: pair.privateKey,
    JWT_PUBLIC_KEY: pair.publicKey,
    MASTER_KEY: 'rahasia-induk-uji-yang-cukup-panjang',
    HMAC_KEY_VERSION: '1',
  });

  const logger = createLogger(config);

  const app = buildServer({
    config,
    logger,
    db: { db, sql: null as never, close: () => Promise.resolve() },
    redis: { redis: redis as unknown as Redis, close: () => Promise.resolve() },
    version: 'test',
  });

  /* Dependensi dirakit lewat jalur produksi. Hanya penyaluran kode yang
     diganti — kotak masuk adalah satu-satunya hal yang tidak ada di sini. */
  registerAuthRoutes(app, {
    ...(await buildAuthDeps({ config, db, redis: redis as unknown as Redis, logger })),
    deliverCode: (to, purpose, code) => {
      delivered = { to, purpose, code };
      return Promise.resolve();
    },
  });

  await app.ready();

  return {
    app,
    db,
    redis,
    lastCode: () => delivered,
    close: async () => {
      await app.close();
      await pg.close();
    },
  };
}

export const DEVICE = { deviceId: 'device-uji-0001', platform: 'web' as const };
