import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../platform/db/client.js';
import {
  devices,
  refreshTokens,
  sessions,
  tickets,
  users,
  type UserRow,
} from '../../platform/db/schema.js';
import {
  decryptColumn,
  encryptColumn,
  hmacDigest,
  type KeyProvider,
} from '../../platform/crypto/index.js';
import type { User } from '../../contracts/auth.js';
import { newId } from '../audit/index.js';

/**
 * Akses basis data untuk autentikasi.
 *
 * Lapisan ini TIDAK memuat satu pun aturan bisnis — tidak memutuskan apakah
 * sandi benar, apakah akun terkunci, atau apakah token boleh dirotasi. Ia hanya
 * membaca dan menulis. Aturan hidup di `service.ts`, dan pemisahan itu yang
 * membuat aturannya dapat diuji tanpa basis data.
 */

export interface AccountRecord {
  row: UserRow;
  /** Bentuk yang menyeberang ke klien. Kolom internal tidak pernah ikut. §8 */
  user: User;
}

function toUser(keys: KeyProvider, row: UserRow): User {
  return {
    id: row.id,
    email: decryptColumn(keys, row.emailEncrypted),
    fullName: decryptColumn(keys, row.fullNameEncrypted),
  };
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findAccountByEmail(
  db: Database,
  keys: KeyProvider,
  email: string,
): Promise<AccountRecord | null> {
  const hash = hmacDigest(keys, normaliseEmail(email));

  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.emailHash, hash.digest), isNull(users.deletedAt)))
    .limit(1);

  const row = rows[0];
  return row ? { row, user: toUser(keys, row) } : null;
}

export async function findAccountById(
  db: Database,
  keys: KeyProvider,
  id: string,
): Promise<AccountRecord | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);

  const row = rows[0];
  return row ? { row, user: toUser(keys, row) } : null;
}

export interface CreateAccountInput {
  email: string;
  fullName: string;
  passwordHash: string;
}

export async function createPendingAccount(
  db: Database,
  keys: KeyProvider,
  input: CreateAccountInput,
): Promise<string | null> {
  const email = normaliseEmail(input.email);
  const hash = hmacDigest(keys, email);
  const id = newId('usr');

  const rows = await db
    .insert(users)
    .values({
      id,
      emailHash: hash.digest,
      hmacKeyVersion: hash.keyVersion,
      emailEncrypted: encryptColumn(keys, email),
      fullNameEncrypted: encryptColumn(keys, input.fullName.trim()),
      passwordHash: input.passwordHash,
      status: 'pending_verification',
    })
    /*
     * Balapan pendaftaran diselesaikan indeks unik parsial `users_email_active`,
     * bukan pemeriksaan "apakah email sudah ada" di lapisan layanan — lima
     * permintaan bersamaan seluruhnya lolos pemeriksaan itu.
     *
     * `onConflictDoNothing` mengubah pelanggaran indeks menjadi nol baris
     * alih-alih galat yang lolos sebagai 500. Yang 500 membocorkan bahwa
     * sesuatu di tingkat basis data terjadi, dan memberi penyerang cara
     * membedakan "menang balapan" dari "kalah balapan".
     */
    .onConflictDoNothing({
      target: users.emailHash,
      /* Predikatnya WAJIB ikut. `users_email_active` adalah indeks unik PARSIAL
         (`WHERE deleted_at IS NULL`), dan PostgreSQL menolak ON CONFLICT yang
         targetnya tidak menyebutkan predikat yang sama persis. */
      where: isNull(users.deletedAt),
    })
    .returning({ id: users.id });

  /* Nol baris berarti kalah balapan: alamatnya sudah dipegang pendaftaran lain
     yang selesai lebih dulu. Jawabannya sama persis dengan pemeriksaan awal. */
  if (rows.length === 0) return null;

  return id;
}

export async function activateAccount(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ status: 'active', emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function replacePassword(
  db: Database,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, passwordChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/* ── perangkat ───────────────────────────────────────────────────────── */

export interface DeviceInput {
  deviceId: string;
  platform: string;
  model?: string | undefined;
  appVersion?: string | undefined;
}

/**
 * Mendaftarkan perangkat bila baru, memperbarui `lastSeenAt` bila sudah ada.
 *
 * Mengembalikan `devices.id` INTERNAL — itulah yang masuk ke klaim `did`,
 * bukan `deviceId` mentah dari klien. JWT terbaca siapa pun yang memegangnya.
 *
 * `isNew` ikut dikembalikan karena HANYA fungsi ini yang tahu. Pemanggil yang
 * ingin mengetahuinya sendiri harus menanyakan basis data sekali lagi, dan
 * pertanyaan kedua itu BALAPAN: dua permintaan masuk serentak dari perangkat
 * yang sama dapat sama-sama menyimpulkan "baru" dan mengirim dua peringatan.
 */
export async function upsertDevice(
  db: Database,
  keys: KeyProvider,
  userId: string,
  input: DeviceInput,
): Promise<{ id: string; isNew: boolean }> {
  const hash = hmacDigest(keys, input.deviceId);

  const existing = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.userId, userId), eq(devices.deviceHash, hash.digest)))
    .limit(1);

  const found = existing[0];
  if (found) {
    await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, found.id));
    return { id: found.id, isNew: false };
  }

  const id = newId('dev');
  await db.insert(devices).values({
    id,
    userId,
    deviceHash: hash.digest,
    hmacKeyVersion: hash.keyVersion,
    platform: input.platform,
    model: input.model ?? null,
    appVersion: input.appVersion ?? null,
  });

  return { id, isNew: true };
}

export async function listDevices(db: Database, userId: string) {
  return db
    .select({
      id: devices.id,
      platform: devices.platform,
      model: devices.model,
      appVersion: devices.appVersion,
      firstSeenAt: devices.firstSeenAt,
      lastSeenAt: devices.lastSeenAt,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .where(eq(devices.userId, userId));
}

/* ── sesi dan token ──────────────────────────────────────────────────── */

export interface SessionRecord {
  id: string;
  userId: string;
  deviceId: string;
  closedAt: Date | null;
  absoluteExpiresAt: Date;
}

export async function createSession(
  db: Database,
  userId: string,
  deviceId: string,
  absoluteExpiresAt: Date,
): Promise<string> {
  const id = newId('ses');
  await db.insert(sessions).values({ id, userId, deviceId, absoluteExpiresAt });
  return id;
}

export async function findSession(db: Database, id: string): Promise<SessionRecord | null> {
  const rows = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      deviceId: sessions.deviceId,
      closedAt: sessions.closedAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
    })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export async function closeSession(db: Database, id: string, reason: string): Promise<void> {
  await db
    .update(sessions)
    .set({ closedAt: new Date(), closeReason: reason })
    .where(and(eq(sessions.id, id), isNull(sessions.closedAt)));
}

export async function closeAllSessions(
  db: Database,
  userId: string,
  reason: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ closedAt: new Date(), closeReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.closedAt)));
}

export async function listOpenSessions(db: Database, userId: string) {
  return db
    .select({
      id: sessions.id,
      deviceId: sessions.deviceId,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.closedAt)));
}

export interface TokenRecord {
  id: string;
  sessionId: string;
  generation: number;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export async function insertRefreshToken(
  db: Database,
  sessionId: string,
  tokenHash: Buffer,
  generation: number,
  expiresAt: Date,
): Promise<string> {
  const id = newId('rft');
  await db.insert(refreshTokens).values({ id, sessionId, tokenHash, generation, expiresAt });
  return id;
}

export async function findRefreshToken(
  db: Database,
  tokenHash: Buffer,
): Promise<TokenRecord | null> {
  const rows = await db
    .select({
      id: refreshTokens.id,
      sessionId: refreshTokens.sessionId,
      generation: refreshTokens.generation,
      expiresAt: refreshTokens.expiresAt,
      rotatedAt: refreshTokens.rotatedAt,
      revokedAt: refreshTokens.revokedAt,
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Menandai token sebagai sudah dirotasi, dan mengembalikan apakah PEMANGGIL INI
 * yang berhasil menandainya.
 *
 * `WHERE rotated_at IS NULL` mengubahnya dari penandaan menjadi KLAIM. Tanpa
 * syarat itu, sepuluh permintaan penyegaran yang berangkat bersamaan — keadaan
 * yang benar-benar terjadi ketika sepuluh kueri menemui token kedaluwarsa pada
 * frame yang sama — semuanya membaca `rotated_at IS NULL`, semuanya menerbitkan
 * generasi baru, dan yang datang belakangan lalu terbaca sebagai pemakaian
 * ulang yang mencabut seluruh keluarga. Pengguna keluar dari akunnya tanpa
 * pernah melakukan kesalahan.
 *
 * PostgreSQL menyerialkan UPDATE pada baris yang sama, jadi tepat satu
 * pemanggil menerima `true`.
 */
export async function claimRotation(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(refreshTokens)
    .set({ rotatedAt: new Date() })
    .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.rotatedAt)))
    .returning({ id: refreshTokens.id });

  return rows.length > 0;
}

/** Mencabut SELURUH keluarga. §5.2 — korban dan pencuri sama-sama keluar,
 *  karena tidak mungkin membedakan keduanya. */
export async function revokeFamily(
  db: Database,
  sessionId: string,
  reason: string,
): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)));

  await closeSession(db, sessionId, reason);
}

export async function nextGeneration(db: Database, sessionId: string): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${refreshTokens.generation}), 0)` })
    .from(refreshTokens)
    .where(eq(refreshTokens.sessionId, sessionId));

  return Number(rows[0]?.max ?? 0) + 1;
}

/* ── tiket ───────────────────────────────────────────────────────────── */

export type TicketPurpose = 'email_verification' | 'password_reset';

export async function createTicket(
  db: Database,
  userId: string,
  purpose: TicketPurpose,
  codeHash: string,
  expiresAt: Date,
): Promise<string> {
  const id = newId('tkt');
  await db.insert(tickets).values({ id, userId, purpose, codeHash, expiresAt });
  return id;
}

export async function findTicket(db: Database, id: string) {
  const rows = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function bumpTicketAttempts(db: Database, id: string): Promise<void> {
  await db
    .update(tickets)
    .set({ attempts: sql`${tickets.attempts} + 1` })
    .where(eq(tickets.id, id));
}

export async function consumeTicket(db: Database, id: string): Promise<void> {
  await db.update(tickets).set({ consumedAt: new Date() }).where(eq(tickets.id, id));
}
