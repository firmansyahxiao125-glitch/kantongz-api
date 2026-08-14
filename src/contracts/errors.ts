/**
 * Kode galat autentikasi.
 *
 * BEKU. Ini salinan tepat dari `src/features/auth/types.ts` di aplikasi M2, dan
 * satu-satunya alasan ia ada di sini adalah karena backend harus menghasilkan
 * kode yang sama persis. Menambah satu kode saja akan membuat
 * `Record<AuthErrorCode, string>` di `messages.ts` aplikasi menolak kompilasi —
 * pengaman yang sudah menangkap satu bug nyata di M2.4 dan sengaja dipertahankan.
 *
 * Bertambahnya kode adalah perubahan kontrak, bukan detail implementasi.
 */
export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_taken'
  | 'weak_password'
  | 'invalid_code'
  | 'code_expired'
  | 'network'
  | 'rate_limited'
  | 'session_expired'
  /*
   * Kata sandi BENAR, tetapi akun ini memakai faktor kedua.
   *
   * Kode tersendiri, bukan `invalid_credentials`, karena klien harus dapat
   * membedakan "coba lagi kata sandimu" dari "sekarang masukkan kodenya".
   * Menggabungkan keduanya memaksa pengguna mengetik ulang kata sandi yang
   * sudah benar.
   *
   * Ia hanya pernah dikirim SESUDAH kata sandi terbukti benar, jadi ia tidak
   * memberi tahu penyerang apa pun yang belum ia buktikan.
   */
  | 'totp_required'
  | 'unknown';

/** Pemetaan kode ke status HTTP. M3_SPEC §18. */
export const HTTP_STATUS: Record<AuthErrorCode, number> = {
  invalid_credentials: 401,
  session_expired: 401,
  invalid_code: 401,
  totp_required: 401,
  email_taken: 409,
  code_expired: 410,
  weak_password: 422,
  rate_limited: 429,
  network: 502,
  unknown: 500,
};

/**
 * Galat yang membawa kode kontrak.
 *
 * Apa pun yang dilempar dan BUKAN `AppError` akan keluar sebagai `unknown` —
 * lihat `errorHandler`. Itu disengaja: galat yang tidak pernah dipikirkan tidak
 * boleh membocorkan bentuknya ke klien.
 */
export class AppError extends Error {
  readonly code: AuthErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: AuthErrorCode, message?: string, retryAfterSeconds?: number) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
