import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { App } from '../types.js';

const HEADER = 'x-request-id';

/**
 * Nilai dari luar hanya diterima bila bentuknya aman.
 *
 * Header ini dikendalikan pemanggil dan berakhir di setiap baris log serta di
 * kolom `audit_log.request_id`. Membatasi bentuknya pada karakter korelasi yang
 * wajar menutup penyuntikan log dan pengisian kolom sekaligus.
 */
const SAFE = /^[\w.:-]{8,128}$/;

/**
 * Korelasi ujung ke ujung. M3_SPEC §2.
 *
 * Dibuat bila tidak ada, diteruskan bila ada, dan selalu dikembalikan di header
 * respons. Tanpa ini, menelusuri satu permintaan yang gagal berarti mencocokkan
 * cap waktu antar layanan — pekerjaan yang tidak pernah selesai.
 */
export function generateRequestId(raw: IncomingMessage): string {
  const incoming = raw.headers[HEADER];
  return typeof incoming === 'string' && SAFE.test(incoming) ? incoming : randomUUID();
}

/**
 * `request.id` sudah diisi `genReqId` sebelum hook mana pun berjalan, dan itulah
 * nilai yang dipakai Fastify di log bawaannya. Menghasilkan id kedua di sini
 * akan membuat baris log Fastify dan baris log kita tidak bisa dipertemukan —
 * tepat pada satu-satunya hal yang membuat id ini ada.
 */
export function registerRequestId(app: App): void {
  app.addHook('onRequest', (request, reply, done) => {
    request.requestId = request.id;
    void reply.header(HEADER, request.id);
    done();
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}
