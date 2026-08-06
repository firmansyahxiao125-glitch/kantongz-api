import { randomUUID } from 'node:crypto';

import type { App } from '../types.js';

const HEADER = 'x-request-id';

/**
 * Korelasi ujung ke ujung. M3_SPEC §2.
 *
 * Dibuat bila tidak ada, diteruskan bila ada, dan selalu dikembalikan di header
 * respons. Tanpa ini, menelusuri satu permintaan yang gagal berarti mencocokkan
 * cap waktu antar layanan — pekerjaan yang tidak pernah selesai.
 */
export function registerRequestId(app: App): void {
  app.addHook('onRequest', (request, reply, done) => {
    const incoming = request.headers[HEADER];
    const requestId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();

    request.requestId = requestId;
    void reply.header(HEADER, requestId);
    done();
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}
