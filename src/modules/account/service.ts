import { AppError } from '../../contracts/errors.js';
import type { Database } from '../../platform/db/client.js';
import { verifyPassword, type KeyProvider } from '../../platform/crypto/index.js';
import { writeAudit } from '../audit/index.js';
import * as authRepo from '../auth/repository.js';
import * as ledger from '../ledger/service.js';
import * as repo from './repository.js';

/**
 * Siklus hidup akun: mengunduh seluruh data, dan menutup akun.
 *
 * Keduanya adalah hak pengguna atas datanya sendiri (UU PDP), dan keduanya
 * berat sebelah kalau hanya salah satu ada: menutup akun tanpa bisa mengunduh
 * berarti kehilangan catatan bertahun-tahun; mengunduh tanpa bisa menutup
 * berarti tidak pernah benar-benar bisa pergi.
 */

export interface AccountDeps {
  db: Database;
  keys: KeyProvider;
}

/**
 * Seluruh data pengguna, dalam satu berkas JSON.
 *
 * ── APA YANG IKUT, DAN APA YANG TIDAK ───────────────────────────────────
 *
 * Yang ikut: identitas, dompet, kategori buatan sendiri, SELURUH transaksi,
 * anggaran, dan tujuan. Itulah yang pengguna masukkan sendiri, dan itulah yang
 * akan ia butuhkan kalau pindah ke aplikasi lain.
 *
 * Yang TIDAK ikut, dan sengaja: hash kata sandi, rahasia TOTP, kode pemulihan,
 * hash perangkat, dan token. Semuanya bahan kunci — berkas ekspor lebih mudah
 * bocor daripada basis data (ia dikirim lewat email, disimpan di Unduhan,
 * disalin ke awan), dan bahan kunci di dalamnya mengubah kebocoran berkas
 * menjadi pengambilalihan akun.
 *
 * Kategori SISTEM juga tidak ikut: ia bukan milik pengguna, sama bagi semua
 * orang, dan hanya membuat berkasnya lebih panjang tanpa menambah informasi.
 */
export async function exportAccount(
  deps: AccountDeps,
  userId: string,
): Promise<Record<string, unknown>> {
  const akun = await authRepo.findAccountById(deps.db, deps.keys, userId);
  if (!akun) throw new AppError('session_expired');

  const led = { db: deps.db };
  const [dompet, kategori, anggaran, tujuan] = await Promise.all([
    ledger.listAccounts(led, userId),
    ledger.listCategories(led, userId),
    ledger.listBudgets(led, userId),
    ledger.listGoals(led, userId),
  ]);

  /*
   * Transaksi diambil BERHALAMAN sampai habis, bukan dengan satu kueri tanpa
   * batas. Ekspor adalah satu-satunya tempat yang meminta seluruh riwayat
   * sekaligus, dan pengguna lama dapat punya puluhan ribu baris — kueri tanpa
   * batas di jalur HTTP adalah cara paling mudah membuat satu permintaan
   * menahan memori peladen untuk semua orang.
   */
  const transaksi = [];
  let cursor: string | undefined;
  for (;;) {
    const halaman = await ledger.listTransactions(led, userId, {
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    transaksi.push(...halaman.items);
    if (halaman.nextCursor === null) break;
    cursor = halaman.nextCursor;
  }

  return {
    /* Versi skema ekspor. Berkas yang beredar bertahun-tahun tanpa penanda
       versi tidak dapat dibaca ulang dengan percaya diri. */
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    account: {
      id: akun.user.id,
      email: akun.user.email,
      fullName: akun.user.fullName,
      createdAt: akun.row.createdAt.toISOString(),
    },
    wallets: dompet,
    /* Hanya kategori buatan pengguna. */
    categories: kategori.filter((c) => !c.system),
    transactions: transaksi,
    budgets: anggaran,
    goals: tujuan,
  };
}

/**
 * Menutup akun.
 *
 * ── LEMBUT, DAN DINYATAKAN APA ADANYA ───────────────────────────────────
 *
 * Yang terjadi seketika: akun ditandai terhapus, SELURUH sesi dicabut, dan
 * bahan kunci faktor kedua dimusnahkan. Sesudah ini tidak ada yang bisa masuk,
 * termasuk pemiliknya.
 *
 * Yang TIDAK terjadi: baris buku besarnya belum dihapus dari disk. Penghapusan
 * permanen dijalankan operator, dan antarmuka mengatakan itu apa adanya alih-
 * alih menjanjikan penghapusan seketika yang tidak dilakukan siapa pun.
 * Menjanjikan lebih dari yang dikerjakan adalah bentuk kebocoran data yang
 * paling sering luput: pengguna berhenti khawatir atas data yang masih ada.
 *
 * Alamat email DIBEBASKAN seketika — indeks unik `users_email_active` hanya
 * mencakup baris hidup — sehingga orang yang berubah pikiran dapat mendaftar
 * lagi dengan alamat yang sama.
 *
 * KATA SANDI DIMINTA LAGI. Ini tindakan yang tidak dapat dibatalkan sendiri
 * oleh pengguna, dan perangkat yang tertinggal tidak terkunci tidak boleh
 * cukup untuk melakukannya.
 */
export async function closeAccount(
  deps: AccountDeps,
  userId: string,
  password: string,
  requestId: string,
): Promise<void> {
  const akun = await authRepo.findAccountById(deps.db, deps.keys, userId);
  if (!akun) throw new AppError('session_expired');

  if (!(await verifyPassword(akun.row.passwordHash, password))) {
    throw new AppError('invalid_credentials');
  }

  /* Urutannya: musnahkan bahan kunci, cabut sesi, baru tandai terhapus.
     Menandai lebih dulu lalu gagal di tengah akan meninggalkan akun yang
     terlihat tertutup tetapi tokennya masih hidup. */
  await authRepo.disableTotp(deps.db, userId);
  await authRepo.closeAllSessions(deps.db, userId, 'account_closed');
  await repo.markDeleted(deps.db, userId);

  await writeAudit(deps.db, deps.keys, {
    event: 'account_closed',
    severity: 'warning',
    actorId: userId,
    requestId,
  });
}
