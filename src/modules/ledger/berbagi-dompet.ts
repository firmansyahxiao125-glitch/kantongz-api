import { and, asc, eq } from 'drizzle-orm';

import { decryptColumn, type KeyProvider } from '../../platform/crypto/index.js';
import type { Database } from '../../platform/db/client.js';
import { walletShares } from '../../platform/db/ledger.js';
import { users } from '../../platform/db/schema.js';
import { newId } from '../audit/index.js';

/**
 * Administrasi keanggotaan dompet bersama. G3.
 *
 * ── MENGAPA BERKAS TERSENDIRI, BUKAN DI DALAM `repository.ts` ──────────
 *
 * Karena gerbang `akses-dompet.test.ts` melarang siapa pun selain penyelesai
 * membaca `wallet_shares`, dan larangan itu ada supaya tidak muncul tempat
 * kedua yang MEMUTUSKAN izin.
 *
 * Berkas ini tidak memutuskan apa pun: ia menambah, membaca, dan menghapus
 * baris keanggotaan, seluruhnya sesudah pemanggilnya membuktikan dirinya
 * pemilik. Ia dikecualikan dari gerbang secara eksplisit — dan justru karena
 * itu ia dipisahkan ke berkas kecil yang seluruh isinya dapat dibaca sekali
 * duduk, alih-alih dititipkan ke `repository.ts` yang seribu baris dan
 * menjadi tempat paling wajar bagi penyelesai kedua untuk tumbuh diam-diam.
 */

/**
 * Anggota sebuah dompet, beserta identitasnya.
 *
 * Email dan nama DIDEKRIPSI di sini — pemiliknya memang berhak tahu kepada
 * siapa ia membagikan pembukuannya, dan daftar yang hanya berisi id tidak
 * dapat dipakai memutuskan apa pun.
 *
 * Baris yang tidak dapat didekripsi DILEWATI, bukan menggagalkan seluruh
 * daftar — pelajaran yang sama dengan G1, dan alasannya sama: satu baris
 * yang disandikan kunci lain tidak boleh membuat pemilik kehilangan
 * kemampuan mencabut akses SIAPA PUN.
 */
export async function listShares(
  db: Database,
  keys: KeyProvider,
  accountId: string,
): Promise<
  { memberId: string; email: string; fullName: string; role: 'lihat' | 'catat'; sharedAt: number }[]
> {
  const rows = await db
    .select({
      memberId: walletShares.memberId,
      role: walletShares.role,
      createdAt: walletShares.createdAt,
      emailEncrypted: users.emailEncrypted,
      fullNameEncrypted: users.fullNameEncrypted,
    })
    .from(walletShares)
    .innerJoin(users, eq(users.id, walletShares.memberId))
    .where(eq(walletShares.accountId, accountId))
    .orderBy(asc(walletShares.createdAt));

  const hasil = [];
  for (const r of rows) {
    try {
      hasil.push({
        memberId: r.memberId,
        email: decryptColumn(keys, r.emailEncrypted),
        fullName: decryptColumn(keys, r.fullNameEncrypted),
        role: r.role,
        sharedAt: r.createdAt.getTime(),
      });
    } catch {
      continue;
    }
  }
  return hasil;
}

/**
 * Menambah atau MENGGANTI peran seseorang pada sebuah dompet.
 *
 * `onConflictDoUpdate`, bukan gagal: membalas bentrok pada pembagian kedua
 * memaksa pemilik menghapus lalu menambah lagi hanya untuk menurunkan peran —
 * dan di antara kedua langkah itu ada jendela ketika orangnya tidak punya
 * akses sama sekali.
 */
export async function upsertShare(
  db: Database,
  accountId: string,
  memberId: string,
  role: 'lihat' | 'catat',
): Promise<void> {
  await db
    .insert(walletShares)
    .values({ id: newId('shr'), accountId, memberId, role })
    .onConflictDoUpdate({
      target: [walletShares.accountId, walletShares.memberId],
      set: { role },
    });
}

export async function deleteShare(
  db: Database,
  accountId: string,
  memberId: string,
): Promise<void> {
  await db
    .delete(walletShares)
    .where(and(eq(walletShares.accountId, accountId), eq(walletShares.memberId, memberId)));
}
