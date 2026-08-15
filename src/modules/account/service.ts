import { AppError } from '../../contracts/errors.js';
import { DomainError } from '../../contracts/domain.js';
import type { Database } from '../../platform/db/client.js';
import { verifyPassword, type KeyProvider } from '../../platform/crypto/index.js';
import { writeAudit } from '../audit/index.js';
import * as authRepo from '../auth/repository.js';
import * as recurring from '../ledger/recurring.js';
import * as ledger from '../ledger/service.js';
import * as repo from './repository.js';
import { putuskanPembersihan } from './pembersihan.js';
import { rencanakanPemulihan, type Rencana } from './pemulihan.js';

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
  const [dompet, kategori, anggaran, tujuan, berulang] = await Promise.all([
    ledger.listAccounts(led, userId),
    ledger.listCategories(led, userId),
    ledger.listBudgets(led, userId),
    ledger.listGoals(led, userId),
    recurring.listRecurring(led, userId),
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
    /* Aturan berulang ikut, dan itu bukan kelengkapan belaka: ia satu-satunya
       bagian pembukuan yang menulis SENDIRI setelah pengguna pergi. Berkas
       ekspor yang menyembunyikannya membuat orang mengira sudah melihat
       segalanya, padahal ada yang masih akan bergerak. */
    recurring: berulang,
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

/* ── PEMULIHAN DARI EKSPOR (F2) ───────────────────────────────────────── */

export interface HasilPemulihan {
  /** Benar bila tidak ada yang benar-benar ditulis. */
  pratinjau: boolean;
  jumlah: Rencana['jumlah'];
  dilewati: Rencana['dilewati'];
}

/**
 * Memulihkan pembukuan dari berkas ekspor.
 *
 * ── BAWAANNYA PRATINJAU ────────────────────────────────────────────────
 *
 * Sama seperti impor CSV di modul buku besar, dan atas alasan yang lebih
 * kuat: yang diserahkan di sini seluruh pembukuan seseorang. Kelalaian
 * menyertakan satu bendera tidak boleh berakhir dengan ribuan baris yang
 * tertulis tanpa diminta.
 *
 * ── MENOLAK PEMBUKUAN YANG SUDAH BERISI ────────────────────────────────
 *
 * Pemulihan bukan penggabungan. Menuangkan berkas ekspor ke atas pembukuan
 * yang sudah punya isi menghasilkan setiap dompet, setiap anggaran, dan
 * setiap transaksi DUA KALI — dan tidak ada tombol untuk membatalkannya.
 *
 * Orang yang benar-benar ingin menggabungkan punya jalan lain yang memang
 * dirancang untuk itu: impor CSV, yang mendeteksi duplikat baris demi baris.
 *
 * ── ID DIBUAT ULANG OLEH PEMBUATNYA SENDIRI ────────────────────────────
 *
 * Baris tidak disisipkan langsung ke tabel. Ia dibuat lewat fungsi buku besar
 * yang sama dengan yang dipakai antarmuka — yang menegakkan kepemilikan,
 * memvalidasi bentuknya, dan menghitung saldo. Menulis langsung ke tabel
 * berarti satu jalur kedua yang aturannya harus diingat terpisah, dan jalur
 * kedua selalu tertinggal.
 */
export async function restoreAccount(
  deps: AccountDeps,
  userId: string,
  berkas: unknown,
  opsi: { dryRun: boolean },
  requestId: string,
): Promise<HasilPemulihan> {
  const led = { db: deps.db };

  /* Nol dipakai sebagai id sementara: yang dipakai pelaksana hanya KUNCI
     petanya (id lama mana yang ada), bukan nilainya. Nilai sebenarnya lahir
     dari pembuat masing-masing. */
  const rencana = rencanakanPemulihan(berkas, (jenis, urutan) => `${jenis}-${String(urutan)}`);
  if (!rencana.ok) {
    throw new DomainError('invalid_input', rencana.detail);
  }

  if (opsi.dryRun) {
    return { pratinjau: true, jumlah: rencana.jumlah, dilewati: rencana.dilewati };
  }

  const dompetAda = await ledger.listAccounts(led, userId);
  if (dompetAda.length > 0) {
    throw new DomainError(
      'conflict',
      'pemulihan hanya dapat dijalankan pada pembukuan yang masih kosong; pakai impor CSV untuk menggabungkan',
    );
  }

  const b = berkas as Record<string, unknown>;
  const larik = (k: string): Record<string, unknown>[] =>
    Array.isArray(b[k]) ? (b[k] as Record<string, unknown>[]) : [];

  const teks = (x: unknown): string | undefined =>
    typeof x === 'string' && x.length > 0 ? x : undefined;
  const angka = (x: unknown): number | undefined => (typeof x === 'number' ? x : undefined);

  const petaDompet = new Map<string, string>();
  for (const w of larik('wallets')) {
    const dibuat = await ledger.createAccount(led, userId, {
      name: teks(w.name) ?? 'Dompet',
      kind: (teks(w.kind) ?? 'cash') as 'cash',
      ...(teks(w.currency) === undefined ? {} : { currency: teks(w.currency) }),
      ...(angka(w.openingBalance) === undefined ? {} : { openingBalance: angka(w.openingBalance) }),
    });
    const lama = teks(w.id);
    if (lama !== undefined) petaDompet.set(lama, dibuat.id);
  }

  const petaKategori = new Map<string, string>();
  for (const c of larik('categories')) {
    const dibuat = await ledger.createCategory(led, userId, {
      name: teks(c.name) ?? 'Kategori',
      kind: (teks(c.kind) ?? 'expense') as 'expense',
      /* Ikon dan warna WAJIB di pembuatnya. Berkas ekspor lama boleh saja
         tidak memilikinya, dan menolak seluruh berkas karena satu bidang
         hiasan yang hilang adalah kekakuan yang tidak melindungi apa pun. */
      icon: teks(c.icon) ?? 'tag',
      color: teks(c.color) ?? '#7f7f8b',
    });
    const lama = teks(c.id);
    if (lama !== undefined) petaKategori.set(lama, dibuat.id);
  }

  for (const t of larik('transactions')) {
    const akunLama = teks(t.accountId);
    const akunBaru = akunLama === undefined ? undefined : petaDompet.get(akunLama);
    if (akunBaru === undefined) continue;

    const lawanLama = teks(t.counterAccountId);
    const lawanBaru = lawanLama === undefined ? undefined : petaDompet.get(lawanLama);
    const katLama = teks(t.categoryId);
    const katBaru = katLama === undefined ? undefined : petaKategori.get(katLama);

    await ledger.createTransaction(led, userId, {
      accountId: akunBaru,
      ...(lawanBaru === undefined ? {} : { counterAccountId: lawanBaru }),
      ...(katBaru === undefined ? {} : { categoryId: katBaru }),
      kind: (teks(t.kind) ?? 'expense') as 'expense',
      amount: angka(t.amount) ?? 0,
      occurredAt: angka(t.occurredAt) ?? Date.now(),
      ...(teks(t.note) === undefined ? {} : { note: teks(t.note) }),
      ...(teks(t.merchant) === undefined ? {} : { merchant: teks(t.merchant) }),
    });
  }

  for (const a of larik('budgets')) {
    const katLama = teks(a.categoryId);
    const katBaru = katLama === undefined ? undefined : petaKategori.get(katLama);
    if (katBaru === undefined) continue;

    await ledger.createBudget(led, userId, {
      categoryId: katBaru,
      period: (teks(a.period) ?? 'monthly') as 'monthly',
      amount: angka(a.amount) ?? 0,
      ...(teks(a.startsOn) === undefined ? {} : { startsOn: teks(a.startsOn) }),
    });
  }

  for (const g of larik('goals')) {
    await ledger.createGoal(led, userId, {
      name: teks(g.name) ?? 'Tujuan',
      targetAmount: angka(g.targetAmount) ?? 0,
      ...(teks(g.targetDate) === undefined ? {} : { targetDate: teks(g.targetDate) }),
      ...(teks(g.color) === undefined ? {} : { color: teks(g.color) }),
    });
  }

  for (const r of larik('recurring')) {
    const akunLama = teks(r.accountId);
    const akunBaru = akunLama === undefined ? undefined : petaDompet.get(akunLama);
    if (akunBaru === undefined) continue;

    const katLama = teks(r.categoryId);
    const katBaru = katLama === undefined ? undefined : petaKategori.get(katLama);

    await recurring.createRecurring(led, userId, {
      name: teks(r.name) ?? 'Aturan',
      accountId: akunBaru,
      ...(katBaru === undefined ? {} : { categoryId: katBaru }),
      kind: (teks(r.kind) ?? 'expense') as 'expense',
      amount: angka(r.amount) ?? 0,
      cadence: (teks(r.cadence) ?? 'monthly') as 'monthly',
      interval: angka(r.interval) ?? 1,
      startsOn: teks(r.startsOn) ?? new Date().toISOString().slice(0, 10),
    });
  }

  await writeAudit(deps.db, deps.keys, {
    event: 'account_restored',
    severity: 'warning',
    actorId: userId,
    requestId,
  });

  return { pratinjau: false, jumlah: rencana.jumlah, dilewati: rencana.dilewati };
}

/* ── penghapusan permanen. F4 ────────────────────────────────────────── */

export interface PengaturanPembersihan {
  /** Bawaannya `false` di `config`. Server harus menyalakannya sendiri. */
  aktif: boolean;
  tungguHari: number;
}

export interface HasilPembersihan {
  /** `true` berarti tidak satu baris pun ditulis. Bawaannya begini. */
  pratinjau: boolean;
  jumlah: { transactions: number };
  /** Sudah dihapus-lunak tetapi masa tunggunya belum lewat. */
  belumMatang: number;
  tungguHari: number;
}

/**
 * Menghapus PERMANEN baris yang sudah dihapus-lunak dan sudah matang. F4.
 *
 * ── TIGA PENGHALANG, DAN KETIGANYA HARUS BENAR ─────────────────────────
 *
 *   1. `pengaturan.aktif`  — server menyalakannya lewat `PURGE_ENABLED`
 *   2. `dryRun === false`  — permintaannya menyatakannya, bawaannya pratinjau
 *   3. `deleted_at` sudah melewati masa tunggu
 *
 * Ketiganya diperiksa di sini, dalam urutan itu, dan yang pertama gagal
 * menghentikan seluruhnya. Tidak ada jalur lain yang menghapus baris secara
 * permanen di seluruh repositori ini.
 *
 * ── MENGAPA PRATINJAU MENJADI BAWAAN, BUKAN BENDERA TAMBAHAN ───────────
 *
 * Sama seperti pemulihan dan impor: kelalaian menyertakan bendera tidak boleh
 * berakhir dengan data yang hilang. Di sini taruhannya paling tinggi, karena
 * di sinilah satu-satunya tempat yang tidak punya tombol batal.
 */
export async function purgeDeleted(
  deps: AccountDeps,
  userId: string,
  pengaturan: PengaturanPembersihan,
  opsi: { dryRun: boolean },
  requestId: string,
): Promise<HasilPembersihan> {
  if (!pengaturan.aktif) {
    /*
       Pesannya JELAS, bukan 404 yang menyamar.

       Menyembunyikan keberadaan fitur ini tidak menjaga apa pun: pemanggilnya
       sudah terbukti sebagai pemilik akunnya sendiri, dan yang dirahasiakan
       hanya konfigurasi servernya sendiri. Yang benar-benar dirugikan oleh
       404 adalah orang yang menunggu datanya benar-benar terhapus dan tidak
       pernah diberi tahu bahwa servernya memang tidak melakukannya.
    */
    throw new DomainError(
      'invalid_input',
      'penghapusan permanen tidak diaktifkan di server ini',
    );
  }

  const terhapus = await repo.softDeletedTransactions(deps.db, userId);
  const keputusan = putuskanPembersihan(terhapus, new Date(), pengaturan.tungguHari);

  if (opsi.dryRun) {
    return {
      pratinjau: true,
      jumlah: { transactions: keputusan.hapus.length },
      belumMatang: keputusan.belumMatang.length,
      tungguHari: pengaturan.tungguHari,
    };
  }

  const dihapus = await repo.hardDeleteTransactions(deps.db, userId, keputusan.hapus);

  /* Dicatat sebagai `critical`, bukan `warning`. Ini satu-satunya kejadian di
     sistem ini yang tidak dapat direkonstruksi dari data yang tersisa —
     catatannya adalah satu-satunya jejak bahwa barisnya pernah ada. */
  await writeAudit(deps.db, deps.keys, {
    event: 'account_purged',
    severity: 'critical',
    actorId: userId,
    requestId,
  });

  return {
    pratinjau: false,
    jumlah: { transactions: dihapus },
    belumMatang: keputusan.belumMatang.length,
    tungguHari: pengaturan.tungguHari,
  };
}
