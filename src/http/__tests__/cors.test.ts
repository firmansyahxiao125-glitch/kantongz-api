import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config/index.js';
import { buildServer } from '../server.js';
import type { App } from '../types.js';
import { createMemoryDatabase } from '../../platform/db/memory.js';
import { createMemoryRedis } from '../../platform/redis/memory.js';
import { createLogger } from '../../platform/observability/logger.js';
import type { DbHandle } from '../../platform/db/client.js';

/**
 * CORS adalah kebijakan yang HANYA ditegakkan peramban.
 *
 * `curl` mengabaikannya seluruhnya, jadi verifikasi ujung ke ujung dengan curl
 * tidak pernah bisa menangkap kesalahan di sini — dan memang tidak menangkapnya
 * sampai uji ini ada.
 */

const IZIN = 'https://app.kantongz.id';
const ASING = 'https://penyerang.contoh';

let app: App;
let db: DbHandle;

beforeAll(async () => {
  db = await createMemoryDatabase();
  const redis = createMemoryRedis();

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgres://uji:uji@127.0.0.1:5432/uji',
    REDIS_URL: 'redis://127.0.0.1:6379',
    JWT_ISSUER: 'https://api.kantongz.id',
    JWT_AUDIENCE: 'kantongz-web',
    JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
    JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
    MASTER_KEY: 'rahasia-induk-uji-yang-cukup-panjang',
    CORS_ORIGINS: `${IZIN}, https://staging.kantongz.id`,
  });

  app = buildServer({
    config,
    logger: createLogger(config),
    db,
    redis,
    version: 'test',
  });

  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

function get(origin?: string): Promise<LightMyRequestResponse> {
  return app.inject(origin ? { method: 'GET', url: '/livez', headers: { origin } } : { method: 'GET', url: '/livez' });
}

describe('daftar izin', () => {
  it('memantulkan asal yang terdaftar', async () => {
    const res = await get(IZIN);
    expect(res.headers['access-control-allow-origin']).toBe(IZIN);
  });

  it('memantulkan asal kedua yang terdaftar', async () => {
    const res = await get('https://staging.kantongz.id');
    expect(res.headers['access-control-allow-origin']).toBe('https://staging.kantongz.id');
  });

  /* Inti keseluruhannya: asal yang tidak terdaftar tidak boleh mendapat izin
     apa pun. Peramban yang tidak menerima header ini menolak membacakan
     jawabannya kepada skrip pemanggil. */
  it('TIDAK memberi izin kepada asal asing', async () => {
    const res = await get(ASING);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('tidak pernah menjawab dengan bintang', async () => {
    for (const origin of [IZIN, ASING]) {
      const res = await get(origin);
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    }
  });

  /* Permintaan tanpa `Origin` datang dari klien native, curl, dan pemeriksaan
     kesehatan — bukan konteks peramban, jadi bukan urusan CORS. */
  it('meloloskan permintaan tanpa header Origin', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
  });
});

describe('preflight', () => {
  it('menjawab OPTIONS untuk asal terdaftar dengan metode dan header yang dipakai', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/transactions',
      headers: {
        origin: IZIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(IZIN);
    expect(String(res.headers['access-control-allow-methods'])).toContain('PATCH');
    expect(String(res.headers['access-control-allow-headers'])).toContain('authorization');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('tidak memberi izin preflight kepada asal asing', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/transactions',
      headers: { origin: ASING, 'access-control-request-method': 'POST' },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('kredensial', () => {
  /* Backend ini tidak pernah membaca kuki — refresh token web tinggal di kuki
     `httpOnly` milik BFF. Mengizinkan kredensial hanya membuka CSRF pada
     permukaan yang memang tidak memakainya. */
  it('tidak pernah mengizinkan kredensial', async () => {
    const res = await get(IZIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('membuka x-request-id supaya klien dapat melaporkannya', async () => {
    const res = await get(IZIN);
    expect(String(res.headers['access-control-expose-headers'])).toContain('x-request-id');
  });
});
