import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Skema basis data. M3_SPEC §7.
 *
 * ULID di seluruh tabel: terurut waktu sehingga indeks B-tree tidak
 * terfragmentasi, dan tidak membocorkan jumlah baris seperti `bigserial`.
 */

/** `bytea` tidak disediakan drizzle-orm secara langsung. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const accountStatus = pgEnum('account_status', [
  'pending_verification',
  'active',
  'locked',
  'suspended',
  'closed',
]);

export const ticketPurpose = pgEnum('ticket_purpose', [
  'email_verification',
  'password_reset',
]);

/**
 * Email disimpan DUA KALI dan itu disengaja. §7.
 *
 * Pencarian membutuhkan kesetaraan pasti; enkripsi acak (GCM dengan nonce
 * berbeda tiap baris) tidak bisa dicari. `emailHash` adalah HMAC deterministik
 * untuk indeks dan pencarian; `emailEncrypted` untuk mengembalikan nilainya.
 * Menyimpan email polos berarti satu dump basis data membocorkan seluruh daftar
 * nasabah.
 */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    emailHash: bytea('email_hash').notNull(),
    hmacKeyVersion: smallint('hmac_key_version').notNull(),
    emailEncrypted: bytea('email_encrypted').notNull(),
    fullNameEncrypted: bytea('full_name_encrypted').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: accountStatus('status').notNull().default('pending_verification'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    /*
     * Rahasia TOTP, TERENKRIPSI seperti email dan nama.
     *
     * Ia setara kata sandi kedua: siapa pun yang membacanya dapat menerbitkan
     * kode yang sah selamanya, tanpa jejak. Menyimpannya sebagai teks biasa
     * berarti satu pembacaan basis data meniadakan seluruh faktor kedua.
     *
     * Nullable karena 2FA opsional — dan `totpEnabledAt` yang menentukan
     * aktif atau tidak, bukan keberadaan rahasianya. Keduanya berbeda: rahasia
     * sudah ada selama pendaftaran berlangsung, tetapi belum berlaku sampai
     * pengguna membuktikan ia benar-benar dapat membaca kodenya.
     */
    totpSecretEncrypted: bytea('totp_secret_encrypted'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
  },
  (t) => [
    /* Unik hanya untuk akun hidup: pengguna yang memakai hak hapusnya harus
       bisa mendaftar lagi dengan alamat yang sama. §7 */
    uniqueIndex('users_email_active').on(t.emailHash).where(sql`${t.deletedAt} IS NULL`),
  ],
);

/**
 * Kode pemulihan 2FA — satu-satunya jalan masuk ketika ponselnya hilang.
 *
 * DISIMPAN SEBAGAI HASH, bukan teks. Alasannya sama persis dengan kata sandi:
 * kode ini MENGGANTIKAN faktor kedua, jadi membacanya dari basis data cukup
 * untuk melewatinya. Yang disimpan SHA-256 — bukan argon2id — karena kodenya
 * dibangkitkan acak 10 karakter dari alfabet 31 huruf (~49 bit), bukan dipilih
 * manusia; tidak ada kamus yang dapat menebaknya, dan yang dibutuhkan justru
 * verifikasi yang murah.
 *
 * `usedAt` membuatnya SEKALI PAKAI. Kode pemulihan yang dapat dipakai berulang
 * adalah kata sandi permanen yang tercetak di selembar kertas.
 */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: bytea('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* Pencarian selalu "kode milik pengguna ini yang belum terpakai". */
    index('recovery_codes_user_unused').on(t.userId).where(sql`${t.usedAt} IS NULL`),
  ],
);

export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceHash: bytea('device_hash').notNull(),
    hmacKeyVersion: smallint('hmac_key_version').notNull(),
    platform: text('platform').notNull(),
    model: text('model'),
    appVersion: text('app_version'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    trustedAt: timestamp('trusted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('devices_user_hash').on(t.userId, t.deviceHash),
    index('devices_user_active').on(t.userId).where(sql`${t.revokedAt} IS NULL`),
  ],
);

/**
 * `sessions.id` ADALAH identitas keluarga token.
 *
 * Kolom `family_id` terpisah akan menjadi kolom kedua yang harus selalu sepakat
 * dengan yang pertama, tanpa apa pun yang menegakkannya.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeReason: text('close_reason'),
  },
  (t) => [index('sessions_user_open').on(t.userId).where(sql`${t.closedAt} IS NULL`)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    generation: integer('generation').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash').on(t.tokenHash),
    index('refresh_tokens_session').on(t.sessionId),
  ],
);

/**
 * Satu tabel untuk verifikasi dan pemulihan, dibedakan `purpose` — alurnya
 * identik dan dua tabel akan menyimpang seiring waktu.
 *
 * Tiket HANTU untuk email tak dikenal TIDAK PERNAH menyentuh tabel ini (§11):
 * `userId` tetap `NOT NULL`, dan menulis baris untuk permintaan yang tidak sah
 * akan membuka pengisian tabel.
 */
export const tickets = pgTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: ticketPurpose('purpose').notNull(),
    /* argon2id, bukan SHA-256: ruang kode enam digit hanya sejuta kemungkinan
       dan hash cepat bisa dibalik seluruhnya dalam hitungan detik. §7 */
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tickets_open').on(t.userId, t.purpose).where(sql`${t.consumedAt} IS NULL`)],
);

export const outbox = pgTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    topic: text('topic').notNull(),
    /* Diteruskan ke penyedia email. Percobaan ulang setelah kegagalan parsial —
       pesan terkirim, penandaan gagal — tidak menghasilkan email kedua. §7 */
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    deadLettered: boolean('dead_lettered').notNull().default(false),
  },
  (t) => [
    uniqueIndex('outbox_idempotency').on(t.idempotencyKey),
    index('outbox_pending').on(t.createdAt).where(sql`${t.publishedAt} IS NULL`),
  ],
);

/**
 * Append-only. Layanan aplikasi punya INSERT, tidak punya UPDATE maupun DELETE
 * — ditegakkan lewat hak akses peran basis data, bukan lewat konvensi.
 *
 * `entryHash = SHA256(prevHash || isi baris)`. Menghapus atau mengubah satu
 * baris memutus rantai di seluruh baris sesudahnya. Ini tidak menggantikan WORM
 * di tingkat penyimpanan; ini yang membuat perusakan TERDETEKSI. §14
 */
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  actorId: text('actor_id'),
  actorType: text('actor_type').notNull(),
  event: text('event').notNull(),
  severity: text('severity').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  deviceId: text('device_id'),
  ipHash: bytea('ip_hash'),
  hmacKeyVersion: smallint('hmac_key_version').notNull(),
  userAgent: text('user_agent'),
  requestId: text('request_id').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  prevHash: bytea('prev_hash'),
  entryHash: bytea('entry_hash').notNull(),
});

export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
});

export const permissions = pgTable('permissions', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: text('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id),
    grantedBy: text('granted_by'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const usersRelations = relations(users, ({ many }) => ({
  devices: many(devices),
  sessions: many(sessions),
  tickets: many(tickets),
  roles: many(userRoles),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
  device: one(devices, { fields: [sessions.deviceId], references: [devices.id] }),
  tokens: many(refreshTokens),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  session: one(sessions, { fields: [refreshTokens.sessionId], references: [sessions.id] }),
}));

export type UserRow = typeof users.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
