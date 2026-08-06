import { createHash } from 'node:crypto';

/**
 * Rotasi refresh token dengan deteksi pemakaian ulang. M3_SPEC §5.
 *
 * Berkas ini murni KEPUTUSAN — tanpa basis data, tanpa Redis, tanpa HTTP.
 * Seluruh aturan §5 ada di satu fungsi yang dapat diuji tanpa satu pun
 * infrastruktur. Itu disengaja: aturan yang tersebar di antara kueri tidak
 * pernah bisa dibaca sebagai satu kesatuan, dan aturan inilah bagian paling
 * penting dari keseluruhan sistem.
 */

/** M3_SPEC §5.3 — jendela toleransi 10 detik. */
export const GRACE_WINDOW_MS = 10_000;

/** §4.1 — umur refresh token. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** §6 — batas mutlak sesi. Sesi yang bisa hidup selamanya lewat refresh
 *  berulang bukan sesi; ia kredensial permanen. */
export const ABSOLUTE_SESSION_MS = 90 * 24 * 60 * 60 * 1000;

export function hashRefreshToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Keadaan token sebagaimana tercatat di basis data. */
export interface StoredToken {
  sessionId: string;
  generation: number;
  expiresAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
}

export interface SessionState {
  closedAt: number | null;
  absoluteExpiresAt: number;
  deviceId: string;
}

export interface RotationInput {
  token: StoredToken | null;
  session: SessionState | null;
  /** `devices.id` dari permintaan — §15. */
  requestDeviceId: string;
  /** Apakah Redis sedang sehat. §5.3 */
  cacheHealthy: boolean;
  /** Entri grace bila ada dan cache sehat. */
  graceHit: boolean;
  now: number;
}

export type RotationDecision =
  /** Rotasi biasa: terbitkan generasi berikutnya. */
  | { kind: 'rotate' }
  /** Kembalikan respons yang sudah ada di cache grace. */
  | { kind: 'replay' }
  /** Rotasi meski di dalam jendela grace, karena cache tidak dapat dipercaya. */
  | { kind: 'rotate_degraded' }
  /** Cabut seluruh keluarga dan tolak. */
  | { kind: 'revoke_family'; reason: 'reuse' | 'device_mismatch' }
  /** Tolak tanpa mencabut apa pun — token memang tidak dikenal atau mati. */
  | { kind: 'reject'; reason: 'unknown' | 'expired' | 'session_closed' | 'session_absolute' };

/**
 * Satu fungsi, seluruh aturan §5.
 *
 * Urutan pemeriksaannya adalah aturannya. Memindahkan pemeriksaan perangkat ke
 * bawah pemeriksaan rotasi, misalnya, akan membuat token curian dari perangkat
 * lain lolos selama ia masih di dalam jendela grace.
 */
export function decideRotation(input: RotationInput): RotationDecision {
  const { token, session, now } = input;

  if (!token) return { kind: 'reject', reason: 'unknown' };
  if (!session) return { kind: 'reject', reason: 'unknown' };

  if (session.closedAt !== null) return { kind: 'reject', reason: 'session_closed' };
  if (session.absoluteExpiresAt <= now) return { kind: 'reject', reason: 'session_absolute' };

  /*
   * Pengikatan perangkat diperiksa SEBELUM apa pun tentang rotasi. §15 —
   * token yang berpindah perangkat mencabut keluarga, tanpa memandang apakah
   * ia masih segar.
   */
  if (session.deviceId !== input.requestDeviceId) {
    return { kind: 'revoke_family', reason: 'device_mismatch' };
  }

  if (token.expiresAt <= now) return { kind: 'reject', reason: 'expired' };

  /* Token yang sudah dicabut selalu berarti pemakaian ulang — tidak ada
     jendela toleransi untuk ini. */
  if (token.revokedAt !== null) return { kind: 'revoke_family', reason: 'reuse' };

  if (token.rotatedAt === null) return { kind: 'rotate' };

  const sejakRotasi = now - token.rotatedAt;

  if (sejakRotasi >= GRACE_WINDOW_MS) {
    return { kind: 'revoke_family', reason: 'reuse' };
  }

  /*
   * Di dalam jendela grace. Dua cabang, dan perbedaannya menentukan apakah
   * satu gangguan Redis mengeluarkan seluruh pengguna aktif.
   *
   * Cache tidak sehat: JANGAN terapkan deteksi pemakaian ulang. Redis yang
   * jatuh membuat setiap entri tampak hilang, dan menghukum semuanya akan
   * mencabut keluarga token setiap kali ada refresh yang diulang. §5.3
   */
  if (!input.cacheHealthy) return { kind: 'rotate_degraded' };

  return input.graceHit ? { kind: 'replay' } : { kind: 'revoke_family', reason: 'reuse' };
}

/** §5.1 — token hasil rotasi tidak boleh melampaui batas mutlak sesi. */
export function refreshExpiryFor(session: SessionState, now: number): number {
  return Math.min(now + REFRESH_TTL_MS, session.absoluteExpiresAt);
}
