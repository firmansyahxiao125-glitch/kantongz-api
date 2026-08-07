import { AppError } from '../../contracts/errors.js';
import { DomainError } from '../../contracts/domain.js';
import { success } from '../../http/envelope.js';
import type { App } from '../../http/types.js';
import { verifyAccessToken, type IssuerConfig } from '../tokens/jwt.js';
import type { KeyRing } from '../tokens/keys.js';
import { MAX_IMAGE_BYTES, type ReceiptReader } from './reader.js';

/**
 * Rute Snap-Struk. ROADMAP M6.
 *
 * Menerima gambar mentah di badan permintaan, bukan multipart. Yang dikirim
 * hanya satu berkas tanpa metadata apa pun, dan multipart menambah pengurai
 * beserta seluruh kelas kerentanannya demi kemudahan yang tidak dibutuhkan.
 *
 * Mengembalikan RANCANGAN, bukan transaksi. Pengguna selalu mengonfirmasi
 * sebelum apa pun tersimpan — struk yang terbaca separuh menghasilkan angka
 * yang terlihat sah, dan pencatatan otomatis akan mengisi pembukuan dengan
 * angka yang tidak pernah diperiksa siapa pun.
 */

export interface ReceiptRouteDeps {
  reader: ReceiptReader;
  ring: KeyRing;
  issuer: IssuerConfig;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function registerReceiptRoutes(app: App, deps: ReceiptRouteDeps): void {
  /* Batas badan permintaan global adalah 16 KB (§2). Gambar jelas melampauinya,
     jadi rute ini menyatakan batasnya sendiri — dan batas itu tetap ada, bukan
     dihapus. */
  app.addContentTypeParser(
    IMAGE_TYPES,
    { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post('/v1/receipts/scan', async (request, reply) => {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AppError('session_expired');
    }
    await verifyAccessToken(deps.ring, deps.issuer, header.slice(7));

    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new DomainError('invalid_input', 'kirim gambar sebagai badan permintaan');
    }

    void reply.send(success(await deps.reader.read(body), request.requestId));
  });
}
