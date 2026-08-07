import type { Redis } from 'ioredis';

import type { RedisHandle } from './client.js';

/**
 * Redis dalam memori.
 *
 * Hanya perintah yang benar-benar dipakai modul autentikasi: pembatasan laju,
 * kuota aksi, dan cache grace rotasi. Menirunya lebih luas berarti menguji
 * tiruan itu sendiri alih-alih kode yang memakainya.
 *
 * Dipakai `dev:standalone`. BUKAN untuk produksi: isinya tidak dibagi antar
 * instans, jadi pembatasan laju hanya berlaku per proses — dan pembatasan laju
 * yang dapat dilewati dengan mengganti instans bukan pembatasan laju.
 */
class MemoryRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

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
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  set(key: string, value: string, mode?: string, ttl?: number): Promise<'OK'> {
    const expiresAt = mode === 'PX' && typeof ttl === 'number' ? Date.now() + ttl : null;
    this.store.set(key, { value, expiresAt });
    return Promise.resolve('OK');
  }

  incr(key: string): Promise<number> {
    const existing = this.live(key);
    const next = Number(existing?.value ?? '0') + 1;
    this.store.set(key, { value: String(next), expiresAt: existing?.expiresAt ?? null });
    return Promise.resolve(next);
  }

  expire(key: string, seconds: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) return Promise.resolve(0);
    entry.expiresAt = Date.now() + seconds * 1000;
    return Promise.resolve(1);
  }

  pttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) return Promise.resolve(-2);
    return Promise.resolve(entry.expiresAt === null ? -1 : entry.expiresAt - Date.now());
  }

  async ttl(key: string): Promise<number> {
    const ms = await this.pttl(key);
    return ms > 0 ? Math.ceil(ms / 1000) : ms;
  }

  del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return Promise.resolve(removed);
  }

  ping(): Promise<'PONG'> {
    return Promise.resolve('PONG');
  }

  disconnect(): void {
    this.store.clear();
  }
}

export function createMemoryRedis(): RedisHandle {
  const redis = new MemoryRedis();

  return {
    redis: redis as unknown as Redis,
    close: () => {
      redis.disconnect();
      return Promise.resolve();
    },
  };
}
