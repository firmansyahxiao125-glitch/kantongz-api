import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';

import type { Database } from '../../platform/db/client.js';
import { outbox } from '../../platform/db/schema.js';
import { newId } from '../audit/index.js';

/**
 * Outbox transaksional. M3_SPEC §7.
 *
 * Baris ditulis dalam transaksi yang SAMA dengan perubahan akun. Tanpa itu,
 * akun bisa terbuat sementara email verifikasinya tidak pernah terkirim — dan
 * pengguna terjebak dengan akun yang tidak bisa diaktifkan dan tidak bisa
 * didaftar ulang.
 *
 * Pengiriman bersifat AT-LEAST-ONCE. `idempotencyKey` diteruskan ke penyedia
 * sehingga percobaan ulang setelah kegagalan parsial — pesan terkirim, penandaan
 * `published_at` gagal — tidak menghasilkan email kedua.
 */

export type OutboxTopic = 'email.verify' | 'email.reset' | 'email.password_changed';

export interface EmailPayload {
  to: string;
  /** Hanya ada pada topik yang memang mengirim kode. */
  code?: string;
  /** Nama penerima, untuk sapaan. */
  name?: string;
}

export interface OutboxMessage {
  id: string;
  topic: OutboxTopic;
  idempotencyKey: string;
  payload: EmailPayload;
  attempts: number;
}

/** Berapa kali sebuah pesan dicoba sebelum masuk dead letter. Di atas ini
 *  percobaan berikutnya hampir pasti gagal dengan sebab yang sama, dan antrean
 *  yang tidak pernah menyerah akan menghalangi pesan yang masih bisa terkirim. */
export const MAX_ATTEMPTS = 5;

/**
 * Menulis pesan ke outbox.
 *
 * `db` di sini boleh berupa handle transaksi — dan pada jalur pendaftaran
 * memang harus, karena itulah satu-satunya yang membuat "akun terbuat" dan
 * "email diantrekan" menjadi satu keputusan atomik.
 */
export async function enqueue(
  db: Database,
  topic: OutboxTopic,
  idempotencyKey: string,
  payload: EmailPayload,
): Promise<void> {
  await db
    .insert(outbox)
    .values({ id: newId('obx'), topic, idempotencyKey, payload })
    /* Kunci yang sama berarti pesan yang sama sudah diantrekan. Mengabaikannya
       di sini membuat pemanggil aman diulang tanpa harus memeriksa lebih dulu. */
    .onConflictDoNothing({ target: outbox.idempotencyKey });
}

/**
 * Mengambil pesan yang siap dikirim dan MENGUNCINYA.
 *
 * `FOR UPDATE SKIP LOCKED` adalah inti dari kebenaran pekerja jamak: dua
 * pekerja yang menjalankan kueri ini bersamaan mendapat baris yang berlainan,
 * tanpa satu pun menunggu yang lain. Tanpa `SKIP LOCKED`, pekerja kedua
 * memblokir sampai transaksi pertama selesai dan seluruh paralelismenya hilang;
 * tanpa `FOR UPDATE`, keduanya mengirim email yang sama.
 */
export async function claimBatch(db: Database, limit: number): Promise<OutboxMessage[]> {
  const rows = await db
    .select({
      id: outbox.id,
      topic: outbox.topic,
      idempotencyKey: outbox.idempotencyKey,
      payload: outbox.payload,
      attempts: outbox.attempts,
    })
    .from(outbox)
    .where(
      and(
        isNull(outbox.publishedAt),
        eq(outbox.deadLettered, false),
        lt(outbox.attempts, MAX_ATTEMPTS),
      ),
    )
    .orderBy(asc(outbox.createdAt))
    .limit(limit)
    .for('update', { skipLocked: true });

  return rows.map((row) => ({
    id: row.id,
    topic: row.topic as OutboxTopic,
    idempotencyKey: row.idempotencyKey,
    payload: row.payload as EmailPayload,
    attempts: row.attempts,
  }));
}

export async function markPublished(db: Database, id: string): Promise<void> {
  await db
    .update(outbox)
    .set({ publishedAt: new Date(), lastError: null })
    .where(eq(outbox.id, id));
}

/**
 * Mencatat kegagalan dan, pada percobaan terakhir, memindahkan ke dead letter.
 *
 * Dead letter bukan tempat pembuangan: ia adalah antrean yang HARUS dilihat
 * manusia. Pesan yang gagal lima kali berarti ada yang salah dengan alamatnya
 * atau dengan penyedianya, dan keduanya butuh keputusan yang tidak bisa diambil
 * oleh percobaan keenam.
 */
export async function markFailed(db: Database, id: string, error: string): Promise<void> {
  await db
    .update(outbox)
    .set({
      attempts: sql`${outbox.attempts} + 1`,
      /* Dipotong: pesan galat penyedia bisa memuat seluruh badan permintaan,
         dan badan permintaan email memuat kode verifikasi. */
      lastError: error.slice(0, 200),
      deadLettered: sql`${outbox.attempts} + 1 >= ${MAX_ATTEMPTS}`,
    })
    .where(eq(outbox.id, id));
}

export interface OutboxStats {
  pending: number;
  deadLettered: number;
}

/** Dipakai `/readyz` dan pemantauan. Antrean yang menumpuk adalah gejala paling
 *  awal dari penyedia email yang sedang jatuh. */
export async function stats(db: Database): Promise<OutboxStats> {
  const rows = await db
    .select({
      pending: sql<string>`COUNT(*) FILTER (WHERE ${outbox.publishedAt} IS NULL AND ${outbox.deadLettered} = false)`,
      deadLettered: sql<string>`COUNT(*) FILTER (WHERE ${outbox.deadLettered} = true)`,
    })
    .from(outbox);

  return {
    pending: Number(rows[0]?.pending ?? 0),
    deadLettered: Number(rows[0]?.deadLettered ?? 0),
  };
}
