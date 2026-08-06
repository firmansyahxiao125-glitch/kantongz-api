import { desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';

import type { Database } from '../../platform/db/client.js';
import { auditLog } from '../../platform/db/schema.js';
import { hmacDigest, type KeyProvider } from '../../platform/crypto/index.js';

/**
 * Jejak audit berantai. M3_SPEC §14.
 *
 * `entryHash = SHA256(prevHash ‖ isi baris)`. Menghapus atau mengubah satu
 * baris memutus rantai di seluruh baris sesudahnya. Ini tidak menggantikan WORM
 * di tingkat penyimpanan — ini yang membuat perusakan TERDETEKSI.
 */

export type AuditSeverity = 'info' | 'warning' | 'critical';

export type AuditEvent =
  | 'sign_in_success'
  | 'sign_in_failed'
  | 'account_locked'
  | 'register_started'
  | 'email_verified'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'refresh_rotated'
  | 'refresh_reuse_detected'
  | 'grace_degraded'
  | 'device_mismatch'
  | 'device_registered'
  | 'session_revoked'
  | 'all_sessions_revoked';

export interface AuditEntry {
  event: AuditEvent;
  severity: AuditSeverity;
  actorId?: string | null;
  actorType?: 'user' | 'system' | 'staff';
  targetType?: string | null;
  targetId?: string | null;
  deviceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Yang TIDAK PERNAH dicatat: sandi, token, kode verifikasi, IP polos, nomor
 * rekening. IP disimpan sebagai HMAC — UU PDP menuntutnya, dan konsekuensinya
 * korelasi lintas-versi kunci memang hilang saat rotasi (§7.1).
 */
export async function writeAudit(
  db: Database,
  keys: KeyProvider,
  entry: AuditEntry,
): Promise<void> {
  const previous = await db
    .select({ entryHash: auditLog.entryHash })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(1);

  const prevHash = previous[0]?.entryHash ?? null;
  const ip = entry.ip ? hmacDigest(keys, entry.ip) : null;

  const body = JSON.stringify({
    event: entry.event,
    severity: entry.severity,
    actorId: entry.actorId ?? null,
    targetId: entry.targetId ?? null,
    requestId: entry.requestId,
    metadata: entry.metadata ?? {},
  });

  const entryHash = createHash('sha256')
    .update(prevHash ?? Buffer.alloc(0))
    .update(body, 'utf8')
    .digest();

  await db.insert(auditLog).values({
    actorId: entry.actorId ?? null,
    actorType: entry.actorType ?? 'user',
    event: entry.event,
    severity: entry.severity,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    deviceId: entry.deviceId ?? null,
    ipHash: ip?.digest ?? null,
    hmacKeyVersion: ip?.keyVersion ?? keys.activeHmacVersion,
    userAgent: entry.userAgent ?? null,
    requestId: entry.requestId,
    metadata: entry.metadata ?? {},
    prevHash,
    entryHash,
  });
}

export interface ChainVerification {
  intact: boolean;
  checked: number;
  brokenAtId: string | null;
}

/**
 * Memverifikasi rantai dari awal.
 *
 * Dipakai setelah pemulihan bencana (§19.4 langkah 5) dan oleh audit berkala.
 * Rantai yang putus tidak memberi tahu APA yang diubah — hanya bahwa sesuatu
 * diubah, dan sejak baris mana. Itu sudah cukup untuk memicu penyelidikan.
 */
export async function verifyAuditChain(db: Database): Promise<ChainVerification> {
  const rows = await db
    .select({
      id: auditLog.id,
      event: auditLog.event,
      severity: auditLog.severity,
      actorId: auditLog.actorId,
      targetId: auditLog.targetId,
      requestId: auditLog.requestId,
      metadata: auditLog.metadata,
      prevHash: auditLog.prevHash,
      entryHash: auditLog.entryHash,
    })
    .from(auditLog)
    .orderBy(auditLog.id);

  let expectedPrev: Buffer | null = null;
  /* Anotasi eksplisit: tanpa ini TypeScript melihat `computed` dirujuk lewat
     `expectedPrev` di iterasi berikutnya dan menyerah menyimpulkan tipenya. */

  for (const row of rows) {
    const body = JSON.stringify({
      event: row.event,
      severity: row.severity,
      actorId: row.actorId,
      targetId: row.targetId,
      requestId: row.requestId,
      metadata: row.metadata,
    });

    const computed: Buffer = createHash('sha256')
      .update(expectedPrev ?? Buffer.alloc(0))
      .update(body, 'utf8')
      .digest();

    if (!computed.equals(row.entryHash)) {
      return { intact: false, checked: rows.length, brokenAtId: String(row.id) };
    }

    expectedPrev = row.entryHash;
  }

  return { intact: true, checked: rows.length, brokenAtId: null };
}

/** ULID: terurut waktu sehingga indeks B-tree tidak terfragmentasi, dan tidak
 *  membocorkan jumlah baris seperti `bigserial`. §7 */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

