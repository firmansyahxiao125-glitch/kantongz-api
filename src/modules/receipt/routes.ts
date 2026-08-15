import { AppError } from '../../contracts/errors.js';
import { DomainError } from '../../contracts/domain.js';
import { success } from '../../http/envelope.js';
import type { App } from '../../http/types.js';
import { verifyAccessToken, type IssuerConfig } from '../tokens/jwt.js';
import type { KeyRing } from '../tokens/keys.js';
import { buangMetadata } from './metadata.js';
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

    /*
       Metadata dibuang di TITIK MASUK, sebelum OCR menyentuhnya.

       Foto struk dari ponsel membawa jauh lebih banyak daripada yang terlihat
       — koordinat GPS, model perangkat, cap waktu sampai detik. Pada aplikasi
       keuangan itu berarti riwayat belanja seseorang membawa serta riwayat
       LOKASI-nya.

       Dibuang di sini dan bukan sebelum penyimpanan, karena sekali sebuah
       buffer masuk lebih dalam ia akan tercatat di log, di jejak galat, dan
       di mana pun ia sempat lewat. Titik masuk satu-satunya tempat yang
       benar-benar dapat dijamin.

       Format yang tidak dikenali DITOLAK, bukan dilewatkan: melewatkannya
       berarti berkas yang metadatanya tidak pernah diperiksa tetap ikut
       diproses, dan seluruh gunanya pemeriksaan ini hilang pada berkas
       pertama yang formatnya di luar dugaan.
    */
    const bersih = buangMetadata(body);
    if (bersih === null) {
      throw new DomainError('invalid_input', 'format gambar tidak didukung; kirim JPEG atau PNG');
    }

    void reply.send(success(await deps.reader.read(bersih.data), request.requestId));
  });
}
