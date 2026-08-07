import Fastify from 'fastify';

import type { Config } from '../config/index.js';
import type { Logger } from '../platform/observability/logger.js';
import type { DbHandle } from '../platform/db/client.js';
import type { RedisHandle } from '../platform/redis/client.js';
import { registerCors } from './middleware/cors.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { generateRequestId, registerRequestId } from './middleware/requestId.js';
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
