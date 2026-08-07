import type { Redis } from 'ioredis';

import { AppError } from '../../contracts/errors.js';
import type {
  DeviceInfo,
  PendingVerification,
  Session,
  User,
} from '../../contracts/auth.js';
import type { Database } from '../../platform/db/client.js';
import {
  hashPassword,
  isGhostTicket,
  issueGhostTicket,
  randomToken,
  verificationCode,
  verifyPassword,
  verifyPasswordAgainstDecoy,
  type KeyProvider,
} from '../../platform/crypto/index.js';
import { writeAudit, type AuditEntry } from '../audit/index.js';
import { issueAccessToken, type IssuerConfig } from '../tokens/jwt.js';
import type { KeyRing } from '../tokens/keys.js';
import {
  ABSOLUTE_SESSION_MS,
  GRACE_WINDOW_MS,
  decideRotation,
  hashRefreshToken,
  refreshExpiryFor,
} from '../tokens/refresh.js';
import * as repo from './repository.js';
import {
  checkLock,
  clearFailures,
  consumeActionQuota,
  recordFailure,
} from './rateLimit.js';

/**
 * Aturan bisnis autentikasi. M3_SPEC §3, §5, §6, §11, §12, §13.
 *
 * Lapisan ini tidak tahu apa-apa tentang HTTP. Ia menerima nilai dan
 * mengembalikan nilai atau melempar `AppError` — dan itulah yang membuat
 * seluruh aturannya dapat diuji tanpa server.
 */

export interface AuthDeps {
  db: Database;
  redis: Redis;
  keys: KeyProvider;
  ring: KeyRing;
  issuer: IssuerConfig;
}

export interface RequestContext {
  requestId: string;
  ip?: string | null;
  userAgent?: string | null;
}

const VERIFICATION_TTL_MS = 10 * 60_000;
const RESET_TTL_MS = 15 * 60_000;
/** §12 — permintaan pemulihan dibatasi 5 kali per jam per alamat, supaya kotak
 *  masuk orang lain tidak bisa dijadikan sasaran pengiriman berulang.
 *  Batas percobaan kode sendiri hidup di kolom `tickets.max_attempts`. */
const RESET_LIMIT = 5;
const HOUR_SECONDS = 3600;

/** §8 — sandi lemah ditolak di lapisan yang menerbitkan akun, bukan hanya di UI. */
const MIN_PASSWORD_LENGTH = 8;

function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new AppError('weak_password');
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}${'·'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

async function audit(deps: AuthDeps, entry: AuditEntry): Promise<void> {
  await writeAudit(deps.db, deps.keys, entry);
}

async function grantSession(
  deps: AuthDeps,
  user: User,
  userId: string,
  device: DeviceInfo,
  now: number,
): Promise<Session> {
  const deviceRowId = await repo.upsertDevice(deps.db, deps.keys, userId, {
    deviceId: device.deviceId,
    platform: device.platform,
    model: device.model,
    appVersion: device.appVersion,
  });

  const sessionId = await repo.createSession(
    deps.db,
    userId,
    deviceRowId,
    new Date(now + ABSOLUTE_SESSION_MS),
  );

  const refreshToken = randomToken();
  const session = { closedAt: null, absoluteExpiresAt: now + ABSOLUTE_SESSION_MS, deviceId: deviceRowId };

  await repo.insertRefreshToken(
    deps.db,
    sessionId,
    hashRefreshToken(refreshToken),
    1,
    new Date(refreshExpiryFor(session, now)),
  );

  const access = await issueAccessToken(
    deps.ring,
    deps.issuer,
    { sub: userId, sid: sessionId, did: deviceRowId, rol: ['member'] },
    now,
  );

  return {
    user,
    tokens: {
      accessToken: access.token,
      refreshToken,
      accessTokenExpiresAt: access.expiresAt,
    },
  };
}

/* ── masuk ───────────────────────────────────────────────────────────── */

export async function signIn(
  deps: AuthDeps,
  input: { email: string; password: string; device: DeviceInfo },
  ctx: RequestContext,
): Promise<Session> {
  const email = repo.normaliseEmail(input.email);

  /*
   * Penguncian diperiksa SEBELUM kredensial dibandingkan. §13.
   * Penguncian yang masih menjawab benar/salah bukan penguncian.
   */
  const lock = await checkLock(deps.redis, email);
  if (lock.locked) {
    throw new AppError('rate_limited', 'terkunci sementara', lock.retryAfterSeconds);
  }

  const account = await repo.findAccountByEmail(deps.db, deps.keys, email);

  /*
   * Verifikasi waktu tetap untuk email yang tidak ada. §3.1 — tanpa ini,
   * selisih waktu respons memberi tahu penyerang alamat mana yang terdaftar,
   * dan seluruh usaha menyamarkan pesan galat jadi sia-sia.
   */
  if (!account) {
    await verifyPasswordAgainstDecoy(input.password);
    const after = await recordFailure(deps.redis, email);
    await audit(deps, {
      event: after.locked ? 'account_locked' : 'sign_in_failed',
      severity: 'warning',
      actorType: 'system',
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    throw new AppError('invalid_credentials');
  }

  const ok = await verifyPassword(account.row.passwordHash, input.password);
  if (!ok) {
    const after = await recordFailure(deps.redis, email);
    await audit(deps, {
      event: after.locked ? 'account_locked' : 'sign_in_failed',
      severity: 'warning',
      actorId: account.row.id,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    if (after.locked) {
      throw new AppError('rate_limited', 'terkunci sementara', after.retryAfterSeconds);
    }
    throw new AppError('invalid_credentials');
  }

  /* Akun yang belum terverifikasi tidak bisa dipakai masuk. §3.2 */
  if (account.row.status === 'pending_verification') throw new AppError('invalid_credentials');
  if (account.row.status !== 'active') throw new AppError('rate_limited', 'akun tidak aktif', 3600);

  await clearFailures(deps.redis, email);

  const session = await grantSession(deps, account.user, account.row.id, input.device, Date.now());

  await audit(deps, {
    event: 'sign_in_success',
    severity: 'info',
    actorId: account.row.id,
    requestId: ctx.requestId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return session;
}

/* ── pendaftaran ─────────────────────────────────────────────────────── */

export async function register(
  deps: AuthDeps,
  input: { fullName: string; email: string; password: string },
  ctx: RequestContext,
): Promise<PendingVerification & { code: string }> {
  const email = repo.normaliseEmail(input.email);

  /* Isian kosong ditolak di lapisan yang menerbitkan akun, bukan hanya di UI. */
  if (email.length === 0 || input.fullName.trim().length === 0) {
    throw new AppError('invalid_credentials');
  }

  assertPasswordAcceptable(input.password);

  /*
   * Pendaftaran SENGAJA membocorkan bahwa email sudah terpakai. §12 —
   * tanpa pesan ini pengguna yang lupa pernah mendaftar tidak punya jalan
   * keluar. Asimetri terhadap pemulihan disadari dan diterima.
   */
  const existing = await repo.findAccountByEmail(deps.db, deps.keys, email);
  if (existing) throw new AppError('email_taken');

  const userId = await repo.createPendingAccount(deps.db, deps.keys, {
    email,
    fullName: input.fullName,
    passwordHash: await hashPassword(input.password),
  });

  /*
   * Kalah balapan. Pemeriksaan di atas dan penyisipan ini adalah DUA langkah,
   * dan lima permintaan bersamaan seluruhnya lolos langkah pertama — yang
   * menegakkan keunikan adalah indeks `users_email_active`, bukan pemeriksaan
   * itu.
   *
   * Jawabannya sama persis dengan pemeriksaan awal: `email_taken`. Jawaban yang
   * berbeda memberi penyerang cara membedakan "menang balapan" dari "kalah",
   * dan sebelum ini pelanggaran indeks lolos sebagai 500.
   */
  if (userId === null) throw new AppError('email_taken');

  const code = verificationCode();
  const ticket = await repo.createTicket(
    deps.db,
    userId,
    'email_verification',
    await hashPassword(code),
    new Date(Date.now() + VERIFICATION_TTL_MS),
  );

  await audit(deps, {
    event: 'register_started',
    severity: 'info',
    actorId: userId,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { ticket, maskedEmail: maskEmail(email), codeLength: code.length, code };
}

export async function verifyRegistration(
  deps: AuthDeps,
  input: { ticket: string; code: string; device: DeviceInfo },
  ctx: RequestContext,
): Promise<Session> {
  const row = await repo.findTicket(deps.db, input.ticket);

  if (!row || row.purpose !== 'email_verification') throw new AppError('invalid_code');
  if (row.consumedAt) throw new AppError('code_expired');
  if (row.expiresAt.getTime() <= Date.now()) throw new AppError('code_expired');
  if (row.attempts >= row.maxAttempts) throw new AppError('code_expired');

  const ok = await verifyPassword(row.codeHash, input.code);
  if (!ok) {
    await repo.bumpTicketAttempts(deps.db, row.id);
    throw new AppError('invalid_code');
  }

  await repo.consumeTicket(deps.db, row.id);
  await repo.activateAccount(deps.db, row.userId);

  const account = await repo.findAccountById(deps.db, deps.keys, row.userId);
  if (!account) throw new AppError('unknown');

  const session = await grantSession(deps, account.user, row.userId, input.device, Date.now());

  await audit(deps, {
    event: 'email_verified',
    severity: 'info',
    actorId: row.userId,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return session;
}

/* ── pemulihan sandi ─────────────────────────────────────────────────── */

export async function requestPasswordReset(
  deps: AuthDeps,
  email: string,
  ctx: RequestContext,
): Promise<PendingVerification & { code: string | null }> {
  const normalised = repo.normaliseEmail(email);

  const quota = await consumeActionQuota(deps.redis, normalised, 'reset', RESET_LIMIT, HOUR_SECONDS);
  if (quota.locked) {
    throw new AppError('rate_limited', 'terlalu sering', quota.retryAfterSeconds);
  }

  const account = await repo.findAccountByEmail(deps.db, deps.keys, normalised);

  /*
   * SELALU berhasil, termasuk untuk email yang tidak terdaftar. §11 — bila
   * tidak, layar ini menjadi alat untuk mendaftar alamat mana yang ada.
   *
   * Tiket hantu TIDAK PERNAH menyentuh basis data: `tickets.user_id` bersifat
   * NOT NULL dan tiket hantu memang tidak punya pemilik, dan menulis baris
   * untuk permintaan yang tidak sah membuka pengisian tabel.
   */
  if (!account) {
    return {
      ticket: issueGhostTicket(deps.keys),
      maskedEmail: maskEmail(normalised),
      codeLength: 6,
      code: null,
    };
  }

  const code = verificationCode();
  const ticket = await repo.createTicket(
    deps.db,
    account.row.id,
    'password_reset',
    await hashPassword(code),
    new Date(Date.now() + RESET_TTL_MS),
  );

  await audit(deps, {
    event: 'password_reset_requested',
    severity: 'info',
    actorId: account.row.id,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { ticket, maskedEmail: maskEmail(normalised), codeLength: code.length, code };
}

export async function resetPassword(
  deps: AuthDeps,
  input: { ticket: string; code: string; newPassword: string },
  ctx: RequestContext,
): Promise<void> {
  /*
   * Tiket hantu dikenali di sini lalu ditolak, setelah verifikasi waktu tetap
   * terhadap kode umpan agar waktunya sama dengan tiket sungguhan. §11
   */
  if (isGhostTicket(deps.keys, input.ticket)) {
    await verifyPasswordAgainstDecoy(input.code);
    throw new AppError('invalid_code');
  }

  assertPasswordAcceptable(input.newPassword);

  const row = await repo.findTicket(deps.db, input.ticket);
  if (!row || row.purpose !== 'password_reset') throw new AppError('invalid_code');
  if (row.consumedAt) throw new AppError('code_expired');
  if (row.expiresAt.getTime() <= Date.now()) throw new AppError('code_expired');
  if (row.attempts >= row.maxAttempts) throw new AppError('code_expired');

  const ok = await verifyPassword(row.codeHash, input.code);
  if (!ok) {
    await repo.bumpTicketAttempts(deps.db, row.id);
    throw new AppError('invalid_code');
  }

  await repo.consumeTicket(deps.db, row.id);
  await repo.replacePassword(deps.db, row.userId, await hashPassword(input.newPassword));

  /* SELURUH sesi dicabut. §11 — semua perangkat keluar. */
  await repo.closeAllSessions(deps.db, row.userId, 'password_reset');

  await audit(deps, {
    event: 'password_reset_completed',
    severity: 'warning',
    actorId: row.userId,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  /* TIDAK menghasilkan sesi. Siapa pun yang menguasai kotak masuk tidak
     otomatis berhak masuk tanpa membuktikan sandi barunya. */
}

/* ── rotasi ──────────────────────────────────────────────────────────── */

export interface RotationResult {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
}

const graceKey = (hash: Buffer): string => `grace:${hash.toString('hex')}`;

/**
 * Membaca hasil rotasi yang tersimpan di cache grace.
 *
 * Mengembalikan `null` baik ketika entrinya tidak ada MAUPUN ketika Redis tidak
 * dapat dihubungi. Pemanggil memperlakukan keduanya sama, dan itu disengaja:
 * keduanya berarti "tidak ada jawaban yang dapat dipercaya di sini".
 */
async function readGrace(deps: AuthDeps, hash: Buffer): Promise<RotationResult | null> {
  try {
    const raw = await deps.redis.get(graceKey(hash));
    return raw ? (JSON.parse(raw) as RotationResult) : null;
  } catch {
    return null;
  }
}

/** Berapa lama menunggu pemenang balapan menulis hasilnya ke cache grace. */
const RACE_WAIT_MS = 150;
const RACE_POLL_MS = 15;

/**
 * Menunggu sebentar entri grace muncul.
 *
 * Batasnya sengaja pendek dan tetap: yang ditunggu adalah celah antara satu
 * INSERT dan satu SET Redis di proses yang sama, bukan pekerjaan lambat. Batas
 * yang panjang akan mengubah cabang ini menjadi tempat permintaan menumpuk saat
 * Redis benar-benar jatuh — dan saat Redis jatuh, jawabannya memang harus
 * datang cepat.
 */
async function awaitGrace(deps: AuthDeps, hash: Buffer): Promise<RotationResult | null> {
  const deadline = Date.now() + RACE_WAIT_MS;

  do {
    const cached = await readGrace(deps, hash);
    if (cached) return cached;
    await new Promise((resolve) => setTimeout(resolve, RACE_POLL_MS));
  } while (Date.now() < deadline);

  return null;
}

export async function refresh(
  deps: AuthDeps,
  input: { refreshToken: string; device: DeviceInfo },
  ctx: RequestContext,
): Promise<RotationResult> {
  const now = Date.now();
  const hash = hashRefreshToken(input.refreshToken);

  const stored = await repo.findRefreshToken(deps.db, hash);
  const session = stored ? await repo.findSession(deps.db, stored.sessionId) : null;

  /* Perangkat dipetakan ke id internal lebih dulu supaya perbandingannya
     memakai satuan yang sama dengan yang tersimpan di sesi. */
  const deviceRowId = session
    ? await repo.upsertDevice(deps.db, deps.keys, session.userId, {
        deviceId: input.device.deviceId,
        platform: input.device.platform,
        model: input.device.model,
        appVersion: input.device.appVersion,
      })
    : '';

  let cacheHealthy = true;
  let graceHit = false;
  let cached: RotationResult | null = null;

  try {
    const raw = await deps.redis.get(graceKey(hash));
    if (raw) {
      graceHit = true;
      cached = JSON.parse(raw) as RotationResult;
    }
  } catch {
    cacheHealthy = false;
  }

  const decision = decideRotation({
    token: stored
      ? {
          sessionId: stored.sessionId,
          generation: stored.generation,
          expiresAt: stored.expiresAt.getTime(),
          rotatedAt: stored.rotatedAt?.getTime() ?? null,
          revokedAt: stored.revokedAt?.getTime() ?? null,
        }
      : null,
    session: session
      ? {
          closedAt: session.closedAt?.getTime() ?? null,
          absoluteExpiresAt: session.absoluteExpiresAt.getTime(),
          deviceId: session.deviceId,
        }
      : null,
    requestDeviceId: deviceRowId,
    cacheHealthy,
    graceHit,
    now,
  });

  if (decision.kind === 'replay' && cached) return cached;

  /*
   * BALAPAN, BUKAN PENCURIAN.
   *
   * Sepuluh permintaan penyegaran yang berangkat bersamaan tiba di sini dalam
   * urutan yang tidak dijamin. Yang menang klaim menerbitkan generasi baru lalu
   * menulis cache grace — dan di antara kedua langkah itu ada celah. Permintaan
   * yang membaca basis data di dalam celah tersebut melihat `rotated_at` sudah
   * terisi tetapi cache masih kosong, dan `decideRotation` — dengan benar,
   * berdasarkan apa yang ia lihat — menyimpulkan pemakaian ulang.
   *
   * Akibatnya seluruh keluarga token dicabut dan pengguna keluar dari akunnya
   * tanpa pernah melakukan kesalahan. §21 Tahap 4 menyebutnya
   * `refresh_reuse_detected` PALSU, dan menuntut nol kejadian sebelum peluncuran.
   *
   * Jadi: bila rotasinya baru saja terjadi, cache ditunggu sebentar. Pencurian
   * sungguhan tidak akan pernah menemukan entri itu — pencuri memakai token
   * lama setelah jendela grace lewat, dan cabang ini tidak berlaku untuknya.
   */
  if (
    decision.kind === 'revoke_family' &&
    decision.reason === 'reuse' &&
    stored?.rotatedAt &&
    now - stored.rotatedAt.getTime() < GRACE_WINDOW_MS
  ) {
    const raced = await awaitGrace(deps, hash);
    if (raced) return raced;
  }

  if (decision.kind === 'revoke_family') {
    if (stored) await repo.revokeFamily(deps.db, stored.sessionId, decision.reason);
    await audit(deps, {
      event: decision.reason === 'reuse' ? 'refresh_reuse_detected' : 'device_mismatch',
      severity: 'critical',
      actorId: session?.userId ?? null,
      targetId: stored?.sessionId ?? null,
      requestId: ctx.requestId,
      ip: ctx.ip,
    });
    throw new AppError('session_expired');
  }

  if (decision.kind === 'reject' || !stored || !session) throw new AppError('session_expired');

  if (decision.kind === 'rotate_degraded') {
    await audit(deps, {
      event: 'grace_degraded',
      severity: 'warning',
      actorId: session.userId,
      targetId: session.id,
      requestId: ctx.requestId,
    });
  }

  const account = await repo.findAccountById(deps.db, deps.keys, session.userId);
  if (!account) throw new AppError('session_expired');

  /*
   * KLAIM, bukan penandaan. Dilakukan SEBELUM apa pun diterbitkan.
   *
   * Sepuluh permintaan penyegaran yang berangkat bersamaan — keadaan yang
   * benar-benar terjadi ketika sepuluh kueri menemui token kedaluwarsa pada
   * frame yang sama — seluruhnya membaca `rotated_at IS NULL` dan seluruhnya
   * lolos `decideRotation`. Tanpa klaim atomik, kesepuluhnya menerbitkan
   * generasi baru; yang berikutnya lalu terbaca sebagai pemakaian ulang dan
   * mencabut seluruh keluarga. Pengguna keluar dari akunnya tanpa pernah
   * melakukan kesalahan, dan §21 Tahap 4 menyebut ini `refresh_reuse_detected`
   * palsu.
   *
   * Yang KALAH klaim bukan pencuri — ia peserta balapan yang sah. Ia menunggu
   * hasil pemenang di cache grace dan mengembalikannya, persis seperti
   * pengulangan biasa di dalam jendela grace (§5.3).
   */
  const claimed = await repo.claimRotation(deps.db, stored.id);

  /*
   * Klaim TIDAK ditegakkan pada jalur degradasi.
   *
   * §5.3 sudah memutuskan bahwa ketika cache tidak sehat, deteksi pemakaian
   * ulang tidak diterapkan sama sekali — Redis yang jatuh membuat setiap entri
   * tampak hilang, dan menghukum semuanya akan mengeluarkan seluruh pengguna
   * aktif. Menuntut klaim di sini akan membatalkan keputusan itu lewat pintu
   * belakang.
   */
  if (!claimed && decision.kind !== 'rotate_degraded') {
    const cachedAfterRace = await awaitGrace(deps, hash);
    if (cachedAfterRace) return cachedAfterRace;

    /*
     * Kalah balapan DAN pemenang tidak pernah menulis hasilnya. Menolak dengan
     * `session_expired` adalah pilihan yang benar: memberi generasi baru
     * berarti dua keluarga hidup dari satu induk, dan mencabut keluarga berarti
     * menghukum pengguna karena balapan yang tidak ia sebabkan. Klien
     * menyegarkan lagi, dan percobaan berikutnya menemukan token pemenang.
     */
    throw new AppError('session_expired');
  }

  const nextToken = randomToken();
  const generation = await repo.nextGeneration(deps.db, session.id);

  await repo.insertRefreshToken(
    deps.db,
    session.id,
    hashRefreshToken(nextToken),
    generation,
    new Date(
      refreshExpiryFor(
        {
          closedAt: null,
          absoluteExpiresAt: session.absoluteExpiresAt.getTime(),
          deviceId: session.deviceId,
        },
        now,
      ),
    ),
  );

  const access = await issueAccessToken(
    deps.ring,
    deps.issuer,
    { sub: session.userId, sid: session.id, did: session.deviceId, rol: ['member'] },
    now,
  );

  const result: RotationResult = {
    accessToken: access.token,
    refreshToken: nextToken,
    accessTokenExpiresAt: access.expiresAt,
  };

  /*
   * Respons disimpan di cache grace, terpisah dari basis data. §5.3 —
   * PostgreSQL hanya menyimpan hash, dan hash tidak bisa dibalik, jadi
   * mengembalikan generasi terbaru mustahil tanpa salinan sementara ini.
   */
  try {
    await deps.redis.set(graceKey(hash), JSON.stringify(result), 'PX', GRACE_WINDOW_MS);
  } catch {
    /* Cache yang gagal ditulis hanya menghilangkan toleransi 10 detik pada
       percobaan berikutnya. Rotasi ini sendiri sudah sah. */
  }

  await audit(deps, {
    event: 'refresh_rotated',
    severity: 'info',
    actorId: session.userId,
    targetId: session.id,
    requestId: ctx.requestId,
  });

  return result;
}

/* ── keluar ──────────────────────────────────────────────────────────── */

/**
 * SELALU berhasil. §6 — rute ini tidak boleh bisa dipakai menguji token mana
 * yang berlaku, dan pengguna yang keluar tidak peduli apakah tokennya sudah
 * mati lebih dulu.
 */
export async function signOut(
  deps: AuthDeps,
  refreshToken: string,
  ctx: RequestContext,
): Promise<void> {
  const stored = await repo.findRefreshToken(deps.db, hashRefreshToken(refreshToken));
  if (!stored) return;

  await repo.revokeFamily(deps.db, stored.sessionId, 'sign_out');

  const session = await repo.findSession(deps.db, stored.sessionId);
  await audit(deps, {
    event: 'session_revoked',
    severity: 'info',
    actorId: session?.userId ?? null,
    targetId: stored.sessionId,
    requestId: ctx.requestId,
  });
}

export async function currentUser(deps: AuthDeps, userId: string): Promise<User> {
  const account = await repo.findAccountById(deps.db, deps.keys, userId);
  if (!account) throw new AppError('session_expired');
  return account.user;
}
