/**
 * Bentuk data yang menyeberang ke aplikasi.
 *
 * BEKU — salinan tepat dari `src/features/auth/types.ts` M2. Seluruh UI membaca
 * bentuk ini. Kolom internal seperti `status` atau `passwordChangedAt` tidak
 * pernah menyeberang; lihat M3_SPEC §8.
 */
export interface User {
  id: string;
  email: string;
  fullName: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milidetik. Absolut, bukan durasi — tetap benar setelah aplikasi
   *  ditutup berjam-jam. */
  accessTokenExpiresAt: number;
}

export interface Session {
  user: User;
  tokens: AuthTokens;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface RegistrationInput {
  fullName: string;
  email: string;
  password: string;
}

export interface PendingVerification {
  ticket: string;
  maskedEmail: string;
  codeLength: number;
}

/** Identitas perangkat yang menyertai setiap permintaan auth. M3_SPEC §17. */
export interface DeviceInfo {
  deviceId: string;
  platform: 'ios' | 'android' | 'web';
  model?: string;
  appVersion?: string;
}
