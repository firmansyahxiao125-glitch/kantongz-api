import { HTTP_STATUS, isAppError } from '../../contracts/errors.js';
import type { App } from '../types.js';
import { failure } from '../envelope.js';

/**
 * Satu-satunya tempat galat berubah menjadi respons.
 *
 * ATURAN YANG TIDAK BOLEH DILANGGAR: apa pun yang bukan `AppError` keluar
 * sebagai `unknown` dengan status 500, tanpa pesan aslinya. Galat driver
 * basis data memuat nama tabel; galat validasi memuat bentuk masukan; galat
 * jaringan memuat alamat internal. Tidak satu pun boleh menyeberang.
 *
 * Yang menyeberang hanya kode kontrak dan `requestId` — cukup bagi pengguna
 * untuk melapor, dan cukup bagi kita untuk menemukannya di log.
 */
export function registerErrorHandler(app: App): void {
  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      const status = HTTP_STATUS[error.code];

      request.log.warn(
        { err: { code: error.code, message: error.message }, requestId: request.requestId },
        'permintaan ditolak',
      );

      if (error.retryAfterSeconds !== undefined) {
        void reply.header('retry-after', String(error.retryAfterSeconds));
      }

      void reply
        .status(status)
        .send(failure(error.code, error.message, request.requestId, error.retryAfterSeconds ?? null));
      return;
    }

    /* Badan permintaan yang tidak lolos skema Fastify. Bentuknya bukan rahasia,
       tetapi isinya bisa jadi rahasia — jadi hanya kodenya yang keluar. */
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      request.log.warn({ requestId: request.requestId, statusCode }, 'permintaan tidak valid');
      void reply.status(400).send(failure('unknown', 'Permintaan tidak valid.', request.requestId));
      return;
    }

    request.log.error({ err: error, requestId: request.requestId }, 'galat tak tertangani');
    void reply
      .status(500)
      .send(failure('unknown', 'Terjadi kesalahan yang tidak terduga.', request.requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(failure('unknown', 'Rute tidak ditemukan.', request.requestId));
  });
}
