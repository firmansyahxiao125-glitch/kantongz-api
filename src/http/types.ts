import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Logger } from '../platform/observability/logger.js';

/**
 * Tipe instans Fastify milik aplikasi ini.
 *
 * Fastify memparameterkan instansnya dengan tipe logger yang diberikan. Karena
 * kita menyuntikkan instans pino sendiri, `FastifyInstance` bawaan tidak lagi
 * cocok — dan setiap fungsi yang menerima `app` harus memakai tipe yang sama
 * persis. Satu alias di sini mencegah ketidakcocokan itu tersebar ke setiap
 * berkas rute.
 */
export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;
