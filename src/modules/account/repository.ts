import { eq } from 'drizzle-orm';

import type { Database } from '../../platform/db/client.js';
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
