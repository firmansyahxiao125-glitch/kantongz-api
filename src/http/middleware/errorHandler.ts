import { STATUS_FOR, codeOf } from '../../contracts/domain.js';
import { isAppError } from '../../contracts/errors.js';
import { asConflict } from '../../platform/db/conflict.js';
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
    /*
     * Pelanggaran indeks unik diterjemahkan LEBIH DULU.
     *
     * Tanpa langkah ini ia jatuh ke cabang terakhir dan menjadi 500, padahal
     * `openapi.json` menjanjikan 409 pada tiga rute yang membuatnya. Terjemahan
     * hanya menghasilkan `DomainError` dengan kalimat KURASI dari
     * `platform/db/conflict.ts` — pesan driver dan nilai masukan tidak pernah
     * ikut menyeberang, jadi aturan di atas tetap berlaku utuh.
     */
    const galat = isAppError(error) ? error : (asConflict(error) ?? error);

    if (isAppError(galat)) {
      const code = codeOf(galat);

      request.log.warn(
        { err: { code, message: galat.message }, requestId: request.requestId },
        'permintaan ditolak',
      );

      if (galat.retryAfterSeconds !== undefined) {
        void reply.header('retry-after', String(galat.retryAfterSeconds));
      }

      void reply
        .status(STATUS_FOR[code])
        .send(failure(code, galat.message, request.requestId, galat.retryAfterSeconds ?? null));
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
