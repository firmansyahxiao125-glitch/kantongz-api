import type { Redis } from 'ioredis';

/**
 * Pembatasan laju per akun. M3_SPEC §13 lapis 3.
 *
 * Dua aturan yang diwarisi utuh dari M2 dan WAJIB dipertahankan:
 *
 * 1. Penguncian diperiksa SEBELUM kredensial dibandingkan. Penguncian yang
 *    masih menjawab benar/salah bukan penguncian.
 * 2. Kegagalan dicatat juga untuk email yang TIDAK terdaftar. Kalau hanya email
 *    terdaftar yang dihitung, selisih perilaku itu sendiri menjadi oracle yang
 *    membocorkan alamat mana yang ada.
 *
 * Penegakannya di sini, bukan di klien. Pembatasan laju yang berjalan di
 * perangkat bisa dilewati dengan memasang ulang aplikasi.
 */

export const MAX_ATTEMPTS = 5;

/** §13 — penguncian bertingkat. Penghitung disetel ulang setelah 24 jam tanpa
 *  kegagalan, atau setelah satu kali masuk berhasil. */
export const LOCKOUT_LADDER_MS = [60_000, 5 * 60_000, 30 * 60_000, 24 * 60 * 60_000] as const;

const ATTEMPT_TTL_SECONDS = 24 * 60 * 60;

export interface RateLimitState {
  locked: boolean;
  retryAfterSeconds: number;
}

function attemptKey(subject: string): string {
  return `rl:attempt:${subject}`;
}

function lockKey(subject: string): string {
  return `rl:lock:${subject}`;
}

function tierKey(subject: string): string {
  return `rl:tier:${subject}`;
}

/**
 * Redis yang jatuh membuat pembatasan laju gagal TERTUTUP pada rute auth.
 * §19.5 — pembatasan laju yang gagal terbuka mengundang penebakan sandi tanpa
 * batas, dan itu jauh lebih berbahaya daripada menolak sebagian permintaan sah
 * selama gangguan.
 */
export async function checkLock(redis: Redis, subject: string): Promise<RateLimitState> {
  try {
    const ttl = await redis.pttl(lockKey(subject));
    if (ttl > 0) return { locked: true, retryAfterSeconds: Math.ceil(ttl / 1000) };
    return { locked: false, retryAfterSeconds: 0 };
  } catch {
    return { locked: true, retryAfterSeconds: 60 };
  }
}

/** Mengembalikan keadaan SETELAH kegagalan ini dicatat. */
export async function recordFailure(redis: Redis, subject: string): Promise<RateLimitState> {
  try {
    const count = await redis.incr(attemptKey(subject));
    if (count === 1) await redis.expire(attemptKey(subject), ATTEMPT_TTL_SECONDS);

    if (count < MAX_ATTEMPTS) return { locked: false, retryAfterSeconds: 0 };

    /* Ambang tercapai. Tingkat penguncian naik setiap kali ini terjadi lagi. */
    const tier = await redis.incr(tierKey(subject));
    await redis.expire(tierKey(subject), ATTEMPT_TTL_SECONDS);

    const index = Math.min(tier - 1, LOCKOUT_LADDER_MS.length - 1);
    const durationMs = LOCKOUT_LADDER_MS[index] ?? LOCKOUT_LADDER_MS[0];

    await redis.set(lockKey(subject), '1', 'PX', durationMs);
    await redis.del(attemptKey(subject));

    return { locked: true, retryAfterSeconds: Math.ceil(durationMs / 1000) };
  } catch {
    return { locked: true, retryAfterSeconds: 60 };
  }
}

/** Masuk berhasil menyetel ulang seluruh penghitung, termasuk tingkatnya. */
export async function clearFailures(redis: Redis, subject: string): Promise<void> {
  try {
    await redis.del(attemptKey(subject), lockKey(subject), tierKey(subject));
  } catch {
    /* Gagal membersihkan bukan alasan menggagalkan masuk yang sudah sah.
       Penghitungnya akan kedaluwarsa sendiri dalam 24 jam. */
  }
}

/**
 * Pembatasan aksi non-kredensial. §13 lapis 4 — kirim ulang kode dan permintaan
 * pemulihan, supaya alamat email orang lain tidak bisa dijadikan sasaran
 * pengiriman berulang.
 */
export async function consumeActionQuota(
  redis: Redis,
  subject: string,
  action: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitState> {
  const key = `rl:act:${action}:${subject}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);

    if (count <= limit) return { locked: false, retryAfterSeconds: 0 };

    const ttl = await redis.ttl(key);
    return { locked: true, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
  } catch {
    return { locked: true, retryAfterSeconds: windowSeconds };
  }
}
