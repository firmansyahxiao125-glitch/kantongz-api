import cors from '@fastify/cors';

import type { Config } from '../../config/index.js';
import type { App } from '../types.js';

/**
 * CORS. M3_SPEC §2.
 *
 * Aplikasi mobile tidak membutuhkannya — `fetch` native tidak tunduk pada
 * kebijakan asal. Aplikasi web membutuhkannya untuk setiap panggilan buku besar
 * yang berangkat langsung dari peramban dengan Bearer token, dan tanpa berkas
 * ini seluruh panggilan itu diblokir peramban sebelum sempat berangkat.
 *
 * DAFTAR IZIN, tidak pernah `*`. Dengan `*`, halaman mana pun di internet yang
 * berhasil memperoleh access token pengguna dapat membaca jawaban backend
 * dengannya. Daftar yang kosong berarti tidak ada asal peramban yang
 * diizinkan — bawaan yang benar untuk penyebaran khusus-mobile.
 *
 * Kredensial TIDAK diizinkan. Backend ini tidak pernah membaca kuki: refresh
 * token web tinggal di kuki `httpOnly` milik BFF Next.js, dan panggilan ke sini
 * selalu membawa Bearer. Mengizinkan kredensial hanya membuka CSRF pada
 * permukaan yang memang tidak memakainya.
 */
export function registerCors(app: App, config: Config): void {
  const allowed = new Set(config.CORS_ORIGINS);

  void app.register(cors, {
    origin: (origin, callback) => {
      /* Permintaan tanpa `Origin` datang dari klien native, curl, dan
         pemeriksaan kesehatan. Bukan konteks peramban, jadi bukan urusan CORS. */
      if (!origin) {
        callback(null, true);
        return;
      }

      callback(null, allowed.has(origin));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'accept', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    /* Preflight di-cache sepuluh menit. Tanpa ini setiap PATCH dan DELETE
       membayar satu perjalanan bolak-balik tambahan. */
    maxAge: 600,
  });
}
