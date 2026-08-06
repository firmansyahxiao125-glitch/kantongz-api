import { Redis } from 'ioredis';

import type { Config } from '../../config/index.js';

/**
 * Koneksi Redis.
 *
 * `maxRetriesPerRequest: 1` disengaja. Redis memegang pembatasan laju, daftar
 * cabut, dan cache grace rotasi — seluruhnya punya perilaku degradasi yang
 * ditetapkan M3_SPEC §19.5. Percobaan ulang yang panjang menyembunyikan
 * kegagalan di balik latensi, dan pemanggil tidak pernah sampai ke cabang
 * degradasinya.
 *
 * `enableOfflineQueue: false` untuk alasan yang sama: perintah yang mengantre
 * saat Redis mati akan dieksekusi jauh setelah keputusan diambil.
 */
export interface RedisHandle {
  redis: Redis;
  close: () => Promise<void>;
}

export function createRedis(config: Config): RedisHandle {
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });

  /* Tanpa penangan ini, kegagalan koneksi menjadi unhandled error event dan
     menjatuhkan proses — padahal seluruh desain justru mengandalkan Redis boleh
     jatuh tanpa menjatuhkan layanan. */
  redis.on('error', () => {});

  return {
    redis,
    close: async () => {
      redis.disconnect();
      await Promise.resolve();
    },
  };
}

export async function pingRedis(handle: RedisHandle): Promise<void> {
  await handle.redis.ping();
}
