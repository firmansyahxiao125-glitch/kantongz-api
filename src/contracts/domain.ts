import { AppError, HTTP_STATUS, type AuthErrorCode } from './errors.js';

/**
 * Kode galat di luar autentikasi.
 *
 * `AuthErrorCode` BEKU dan tidak ditambah — ia adalah salinan tepat dari
 * kontrak aplikasi M2, dan menambahnya akan memutus kompilasi di sana. Domain
 * buku besar butuh kode yang tidak dimiliki autentikasi, jadi ia mendapat
 * unionnya sendiri dan keduanya bertemu di `ErrorCode`.
 *
 * Sengaja sedikit. Kode galat yang jumlahnya puluhan tidak pernah dipetakan
 * lengkap oleh klien mana pun, dan yang tidak dipetakan berakhir sebagai pesan
 * mentah di layar pengguna.
 */
export type DomainErrorCode =
  /** Sumber daya tidak ada, atau ada tetapi milik orang lain. Keduanya
   *  menghasilkan jawaban yang sama — membedakannya berarti memberi tahu
   *  penyerang id mana yang benar-benar ada. */
  | 'not_found'
  /** Masukan lolos skema tetapi melanggar aturan domain. */
  | 'invalid_input'
  /** Bentrok dengan sesuatu yang sudah ada. */
  | 'conflict';

export type ErrorCode = AuthErrorCode | DomainErrorCode;

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  invalid_input: 422,
  conflict: 409,
};

export const STATUS_FOR: Record<ErrorCode, number> = { ...HTTP_STATUS, ...DOMAIN_STATUS };

/**
 * Galat domain.
 *
 * Mewarisi `AppError` supaya `isAppError` di penangan galat tetap
 * mengenalinya — satu jalur keluar untuk semua galat yang disengaja, dan tidak
 * ada cabang kedua yang bisa lupa menyensor pesannya.
 */
export class DomainError extends AppError {
  readonly domainCode: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    /* `unknown` adalah kode yang dilihat `AppError`; kode sebenarnya dibawa
       terpisah dan dibaca penangan galat lewat `domainCode`. */
    super('unknown', message);
    this.name = 'DomainError';
    this.domainCode = code;
    Object.setPrototypeOf(this, DomainError.prototype);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** Kode yang benar-benar dikirim ke klien, apa pun kelas galatnya. */
export function codeOf(error: AppError): ErrorCode {
  return isDomainError(error) ? error.domainCode : error.code;
}
