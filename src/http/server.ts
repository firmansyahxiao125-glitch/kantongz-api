import Fastify from 'fastify';

import type { Config } from '../config/index.js';
import type { Logger } from '../platform/observability/logger.js';
import type { DbHandle } from '../platform/db/client.js';
import type { RedisHandle } from '../platform/redis/client.js';
import { registerCors } from './middleware/cors.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { generateRequestId, registerRequestId } from './middleware/requestId.js';
import { recordRequest, renderMetrics, requestEnded, requestStarted } from '../platform/observability/metrics.js';
import { registerOpenApi } from './openapi.js';
import { registerHealthRoutes } from './routes/health.js';
import type { App, RouteEntry } from './types.js';

export interface ServerDeps {
  config: Config;
  logger: Logger;
  db: DbHandle;
  redis: RedisHandle;
  version: string;
}

/**
 * Perakitan server. Tidak ada aturan bisnis di berkas ini — hanya urutan.
 *
 * Urutannya penting: `requestId` dipasang sebagai hook `onRequest` sebelum
 * apa pun, karena penangan galat membacanya. Penangan galat yang berjalan tanpa
 * `requestId` akan melempar di dalam dirinya sendiri, dan galat di dalam
 * penangan galat adalah jenis kegagalan yang paling sulit ditelusuri.
 */
export function buildServer(deps: ServerDeps): App {
  const app = Fastify({
    loggerInstance: deps.logger,
    /* Batas 16 KB pada seluruh rute. M3_SPEC §2. */
    bodyLimit: 16 * 1024,
    /* Satu id, dipakai bersama oleh log bawaan Fastify dan log kita sendiri. */
    genReqId: generateRequestId,
    trustProxy: true,
  });

  /* Dipasang SEBELUM rute mana pun didaftarkan — `onRoute` hanya melihat yang
     datang sesudahnya. */
  app.decorate('routeInventory', [] as RouteEntry[]);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      app.routeInventory.push({ method: method.toLowerCase(), url: route.url });
    }
  });

  registerRequestId(app);
  registerMetrics(app);
  registerCors(app, deps.config);
  registerErrorHandler(app);
  registerOpenApi(app, deps.config.JWT_ISSUER);
  registerHealthRoutes(app, {
    db: deps.db,
    redis: deps.redis,
    startedAt: Date.now(),
    version: deps.version,
  });

  return app;
}

/**
 * Pengumpulan metrik.
 *
 * `request.routeOptions.url` adalah POLA rute (`/v1/goals/:id`), bukan jalur
 * yang diminta (`/v1/goals/goal_01K…`). Perbedaannya menentukan apakah
 * Prometheus menyimpan sepuluh deret waktu atau sepuluh juta — label
 * berkardinalitas tak terbatas adalah penyebab nomor satu instalasi Prometheus
 * yang tumbang.
 *
 * Permintaan ke jalur yang tidak cocok rute mana pun dicatat sebagai
 * `<unmatched>`; memakai jalur mentahnya akan membuat pemindai porta
 * membangkitkan satu deret waktu baru per URL yang dicobanya.
 */
function registerMetrics(app: App): void {
  app.addHook('onRequest', (request, _reply, done) => {
    requestStarted();
    /* Jam monotonik. `Date.now()` melompat saat jam sistem disesuaikan NTP,
       dan lompatan mundur menghasilkan durasi negatif. */
    (request as { metricStart?: bigint }).metricStart = process.hrtime.bigint();
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    requestEnded();

    const started = (request as { metricStart?: bigint }).metricStart;
    if (started !== undefined) {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = request.routeOptions.url ?? '<unmatched>';
      recordRequest(request.method, route, reply.statusCode, seconds);
    }
    done();
  });

  /*
   * `/metrics` TIDAK terdokumentasi di OpenAPI dan TIDAK melalui amplop
   * `data`/`error`. Ia berbicara format eksposisi Prometheus, yang teks
   * biasa — membungkusnya dalam JSON membuatnya tidak dapat dibaca scraper
   * mana pun.
   *
   * KEAMANAN: titik ini membocorkan bentuk lalu lintas — rute mana yang ada,
   * seberapa sering dipanggil, berapa banyak yang gagal. Ia TIDAK boleh
   * terekspos ke internet. `deploy/Caddyfile` tidak meneruskannya, jadi ia
   * hanya dapat dijangkau dari dalam jaringan kontainer.
   */
  app.get('/metrics', (_request, reply) => {
    void reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(renderMetrics());
  });
}
