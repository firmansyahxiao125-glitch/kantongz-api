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
  /**
   * Kode faktor kedua, atau salah satu kode pemulihan.
   *
   * Keduanya diterima di kolom yang SAMA: pengguna yang baru kehilangan
   * ponselnya tidak seharusnya diminta menemukan layar yang berbeda.
   *
   * Opsional karena sebagian besar akun tidak memakai 2FA — dan klien memang
   * belum tahu apakah akun ini memakainya sampai kata sandinya terbukti benar.
   */
  totpCode?: string | undefined;
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
/**
 * Satu sesi yang masih terbuka, sebagaimana dilihat PEMILIKNYA.
 *
 * Bentuknya sengaja tidak memuat apa pun yang dapat dipakai menyalahgunakan
 * sesi lain: tidak ada token, tidak ada `deviceHash`, tidak ada alamat IP.
 * Yang ditampilkan hanyalah yang dibutuhkan seseorang untuk menjawab satu
 * pertanyaan — "apakah ini aku?" — lalu menindaknya.
 *
 * `current` menandai sesi yang sedang dipakai permintaan ini. Tanpa penanda
 * itu, daftar berisi tiga baris serupa dan pengguna yang ingin mengakhiri sesi
 * asing punya peluang besar mengakhiri sesinya sendiri.
 */
export interface ActiveSession {
  id: string;
  platform: string;
  model: string | null;
  appVersion: string | null;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  current: boolean;
}

export interface DeviceInfo {
  deviceId: string;
  platform: 'ios' | 'android' | 'web';
  model?: string | undefined;
  appVersion?: string | undefined;
}
