import type { AuthErrorCode } from '../contracts/errors.js';

/**
 * Amplop respons. M3_SPEC §18.
 *
 * Setiap respons memakai salah satu dari dua bentuk ini — tidak ada rute yang
 * mengembalikan objek telanjang. Klien yang hanya perlu mengenali dua bentuk
 * jauh lebih sederhana daripada klien yang harus menebak.
 */
export interface Meta {
  requestId: string;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta: Meta;
}

export interface ErrorEnvelope {
  error: {
    code: AuthErrorCode;
    message: string;
    details: unknown;
    retryAfter: number | null;
  };
  meta: Meta;
}

export function success<T>(data: T, requestId: string): SuccessEnvelope<T> {
  return { data, meta: { requestId } };
}

export function failure(
  code: AuthErrorCode,
  message: string,
  requestId: string,
  retryAfter: number | null = null,
): ErrorEnvelope {
  return { error: { code, message, details: null, retryAfter }, meta: { requestId } };
}
