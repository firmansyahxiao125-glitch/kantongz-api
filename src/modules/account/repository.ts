import { and, eq, inArray, isNotNull } from 'drizzle-orm';

import type { Database } from '../../platform/db/client.js';
import { transactions } from '../../platform/db/ledger.js';
import { users } from '../../platform/db/schema.js';

/**
 * Menandai akun terhapus.
 *
 * `deleted_at` sudah ada di skema sejak awal, dan indeks unik
 * `users_email_active` sengaja MENGECUALIKAN baris terhapus — itulah yang
 * membuat alamat email langsung bebas dipakai mendaftar lagi. Menghapus baris
 * secara fisik justru akan menyeret seluruh buku besar ikut terhapus lewat
 * `ON DELETE CASCADE`, tanpa sempat diunduh siapa pun.
 */
export async function markDeleted(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ deletedAt: new Date(), status: 'closed', updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/* ── penghapusan permanen. F4 ────────────────────────────────────────── */

/**
 * Transaksi milik satu pengguna yang SUDAH dihapus-lunak.
 *
 * Hanya `id` dan `deleted_at`: keputusan pembersihan tidak membutuhkan yang
 * lain, dan menarik seluruh baris hanya untuk membuang sebagian besarnya
 * membuat kueri ini melambat justru pada akun yang paling banyak menghapus.
 */
export async function softDeletedTransactions(
  db: Database,
  userId: string,
): Promise<{ id: string; deletedAt: Date | null }[]> {
  return db
    .select({ id: transactions.id, deletedAt: transactions.deletedAt })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNotNull(transactions.deletedAt)));
}

/**
 * Menghapus baris SUNGGUHAN. Tidak dapat dibatalkan.
 *
 * `userId` ikut di dalam `WHERE` meski id-nya sudah dipilih oleh kueri di
 * atas yang juga menyaring `userId`. Itu bukan pemeriksaan berlebih: ini
 * satu-satunya pernyataan `DELETE` sungguhan di repositori ini, dan satu
 * pemanggil kelak yang menyusun daftar id-nya sendiri tidak boleh dapat
 * menghapus baris milik orang lain hanya karena ia lupa menyaring.
 *
 * Daftar kosong TIDAK menjalankan apa-apa — `inArray` dengan larik kosong
 * menghasilkan `WHERE false` di sebagian pengandar dan galat di sebagian yang
 * lain, dan tidak satu pun dari keduanya perlu diandalkan di sini.
 */
export async function hardDeleteTransactions(
  db: Database,
  userId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;

  const rows = await db
    .delete(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        isNotNull(transactions.deletedAt),
        inArray(transactions.id, ids),
      ),
    )
    .returning({ id: transactions.id });

  return rows.length;
}
