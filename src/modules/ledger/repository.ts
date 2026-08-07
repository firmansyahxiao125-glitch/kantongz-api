import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';

import type { Database } from '../../platform/db/client.js';
import {
  budgets,
  categories,
  goals,
  transactions,
  walletAccounts,
  type BudgetRow,
  type CategoryRow,
  type GoalRow,
  type TransactionRow,
  type WalletAccountRow,
} from '../../platform/db/ledger.js';
import { newId } from '../audit/index.js';

/**
 * Akses data buku besar. Tanpa satu pun aturan bisnis.
 *
 * SETIAP kueri di berkas ini menyaring `userId`. Bukan sebagai kebiasaan:
 * satu kueri yang lupa melakukannya adalah kebocoran data lintas-nasabah, dan
 * kueri itu akan terlihat persis seperti tetangganya yang benar. Itulah sebabnya
 * `userId` selalu parameter pertama — yang hilang menjadi galat kompilasi.
 */

/* ── dompet ──────────────────────────────────────────────────────────── */

export async function listAccounts(
  db: Database,
  userId: string,
  includeArchived: boolean,
): Promise<WalletAccountRow[]> {
  return db
    .select()
    .from(walletAccounts)
    .where(
      includeArchived
        ? eq(walletAccounts.userId, userId)
        : and(eq(walletAccounts.userId, userId), isNull(walletAccounts.archivedAt)),
    )
    .orderBy(asc(walletAccounts.createdAt));
}

export async function findAccount(
  db: Database,
  userId: string,
  id: string,
): Promise<WalletAccountRow | null> {
  const rows = await db
    .select()
    .from(walletAccounts)
    .where(and(eq(walletAccounts.userId, userId), eq(walletAccounts.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertAccount(
  db: Database,
  userId: string,
  input: {
    name: string;
    kind: WalletAccountRow['kind'];
    currency: string;
    openingBalance: number;
    color: string | null;
  },
): Promise<WalletAccountRow> {
  const rows = await db
    .insert(walletAccounts)
    .values({ id: newId('acc'), userId, ...input })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('insert dompet tidak mengembalikan baris');
  return row;
}

export async function updateAccount(
  db: Database,
  userId: string,
  id: string,
  patch: Partial<{
    name: string;
    kind: WalletAccountRow['kind'];
    color: string | null;
    archivedAt: Date | null;
  }>,
): Promise<WalletAccountRow | null> {
  const rows = await db
    .update(walletAccounts)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(walletAccounts.userId, userId), eq(walletAccounts.id, id)))
    .returning();
  return rows[0] ?? null;
}

/**
 * Saldo per dompet, dihitung dari buku.
 *
 * Satu kueri untuk seluruh dompet, bukan satu kueri per dompet: daftar dua
 * puluh dompet yang memicu dua puluh satu kueri adalah bentuk N+1 yang paling
 * mudah lolos tinjauan karena setiap kuerinya sendiri terlihat murah.
 *
 * Transfer dihitung DUA KALI dari sisi yang berlawanan — keluar dari
 * `account_id`, masuk ke `counter_account_id` — dan itulah alasan satu baris
 * transfer tidak pernah bisa kehilangan pasangannya.
 */
export async function balances(db: Database, userId: string): Promise<Map<string, number>> {
  const alive = and(eq(transactions.userId, userId), isNull(transactions.deletedAt));

  /*
   * Dua agregat, bukan satu subkueri berkorelasi.
   *
   * Subkueri berkorelasi di daftar SELECT akan berjalan sekali per dompet, dan
   * — lebih buruk — rujukan kolom luar di dalamnya bertabrakan dengan kolom
   * bernama sama di tabel dalam. Dua GROUP BY yang digabung di memori tidak
   * punya kedua masalah itu, dan keduanya memakai indeks yang sudah ada.
   */
  const [outgoing, incoming, accounts] = await Promise.all([
    db
      .select({
        accountId: transactions.accountId,
        delta: sql<string>`SUM(CASE WHEN ${transactions.kind} = 'income' THEN ${transactions.amount} ELSE -${transactions.amount} END)`,
      })
      .from(transactions)
      .where(alive)
      .groupBy(transactions.accountId),

    /* Sisi masuk transfer. Baris yang sama, dibaca dari ujung yang lain — dan
       itulah alasan satu baris transfer tidak pernah bisa setengah ada. */
    db
      .select({
        accountId: transactions.counterAccountId,
        delta: sql<string>`SUM(${transactions.amount})`,
      })
      .from(transactions)
      .where(and(alive, eq(transactions.kind, 'transfer')))
      .groupBy(transactions.counterAccountId),

    db
      .select({ id: walletAccounts.id, opening: walletAccounts.openingBalance })
      .from(walletAccounts)
      .where(eq(walletAccounts.userId, userId)),
  ]);

  const balance = new Map(accounts.map((row) => [row.id, row.opening]));

  const apply = (accountId: string | null, delta: string): void => {
    if (accountId === null) return;
    const current = balance.get(accountId);
    if (current !== undefined) balance.set(accountId, current + Number(delta));
  };

  for (const row of outgoing) apply(row.accountId, row.delta);
  for (const row of incoming) apply(row.accountId, row.delta);

  return balance;
}

/* ── kategori ────────────────────────────────────────────────────────── */

export async function listCategories(db: Database, userId: string): Promise<CategoryRow[]> {
  return db
    .select()
    .from(categories)
    .where(
      and(
        or(isNull(categories.userId), eq(categories.userId, userId)),
        isNull(categories.archivedAt),
      ),
    )
    .orderBy(asc(categories.kind), asc(categories.sortOrder), asc(categories.name));
}

export async function findCategory(
  db: Database,
  userId: string,
  id: string,
): Promise<CategoryRow | null> {
  const rows = await db
    .select()
    .from(categories)
    .where(
      and(eq(categories.id, id), or(isNull(categories.userId), eq(categories.userId, userId))),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insertCategory(
  db: Database,
  userId: string,
  input: { name: string; kind: CategoryRow['kind']; icon: string; color: string },
): Promise<CategoryRow> {
  const rows = await db
    .insert(categories)
    .values({ id: newId('cat'), userId, ...input })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('insert kategori tidak mengembalikan baris');
  return row;
}

/** Hanya kategori MILIK pengguna yang bisa disentuh — `userId` yang NULL adalah
 *  bawaan sistem, dan syarat ini yang menegakkannya. */
export async function updateOwnCategory(
  db: Database,
  userId: string,
  id: string,
  patch: Partial<{ name: string; icon: string; color: string; archivedAt: Date | null }>,
): Promise<CategoryRow | null> {
  const rows = await db
    .update(categories)
    .set(patch)
    .where(and(eq(categories.id, id), eq(categories.userId, userId)))
    .returning();
  return rows[0] ?? null;
}

/* ── transaksi ───────────────────────────────────────────────────────── */

/**
 * Kursor halaman.
 *
 * Memuat KEDUA kolom pengurutan, bukan hanya `id`. Daftar diurutkan menurut
 * `occurred_at` sementara `id` mengikuti urutan penulisan, dan keduanya tidak
 * sejalan — transaksi yang dicatat hari ini untuk belanja pekan lalu punya id
 * besar dengan waktu kecil. Kursor yang hanya membawa `id` akan memotong daftar
 * di tempat yang salah, dan halaman kedua akan mengulang atau melewatkan baris.
 */
export function encodeCursor(row: { occurredAt: Date; id: string }): string {
  return `${String(row.occurredAt.getTime())}.${row.id}`;
}

function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const dot = cursor.indexOf('.');
  if (dot <= 0) return null;

  const ms = Number(cursor.slice(0, dot));
  const id = cursor.slice(dot + 1);
  if (!Number.isSafeInteger(ms) || id.length === 0) return null;

  return { at: new Date(ms), id };
}

export interface TransactionFilter {
  accountId?: string | undefined;
  categoryId?: string | undefined;
  kind?: TransactionRow['kind'] | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  cursor?: string | undefined;
  limit: number;
}

function filterConditions(userId: string, filter: TransactionFilter) {
  const after = filter.cursor ? decodeCursor(filter.cursor) : null;

  return and(
    eq(transactions.userId, userId),
    isNull(transactions.deletedAt),
    filter.accountId
      ? or(
          eq(transactions.accountId, filter.accountId),
          eq(transactions.counterAccountId, filter.accountId),
        )
      : undefined,
    filter.categoryId ? eq(transactions.categoryId, filter.categoryId) : undefined,
    filter.kind ? eq(transactions.kind, filter.kind) : undefined,
    filter.from ? gte(transactions.occurredAt, filter.from) : undefined,
    filter.to ? lte(transactions.occurredAt, filter.to) : undefined,
    /*
     * Halaman berikutnya ditentukan kursor, bukan OFFSET. OFFSET melewatkan
     * atau menggandakan baris begitu ada yang disisipkan di antara dua
     * permintaan — dan aplikasi keuangan menyisipkan baris justru saat pengguna
     * sedang menggulir.
     *
     * Perbandingan nilai-baris `(a, b) < (x, y)` adalah satu-satunya bentuk yang
     * setara persis dengan `ORDER BY a DESC, b DESC`. Menulisnya sebagai
     * `a < x OR (a = x AND b < y)` benar juga, tetapi perencana tidak selalu
     * mengenalinya sebagai penelusuran indeks.
     */
    after
      ? sql`(${transactions.occurredAt}, ${transactions.id}) < (${after.at}, ${after.id})`
      : undefined,
  );
}

export async function listTransactions(
  db: Database,
  userId: string,
  filter: TransactionFilter,
): Promise<TransactionRow[]> {
  return db
    .select()
    .from(transactions)
    .where(filterConditions(userId, filter))
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(filter.limit);
}

export async function findTransaction(
  db: Database,
  userId: string,
  id: string,
): Promise<TransactionRow | null> {
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.id, id),
        isNull(transactions.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insertTransaction(
  db: Database,
  userId: string,
  input: {
    accountId: string;
    counterAccountId: string | null;
    categoryId: string | null;
    kind: TransactionRow['kind'];
    amount: number;
    currency: string;
    occurredAt: Date;
    note: string | null;
    merchant: string | null;
  },
): Promise<TransactionRow> {
  const rows = await db
    .insert(transactions)
    .values({ id: newId('trx'), userId, ...input })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('insert transaksi tidak mengembalikan baris');
  return row;
}

export async function updateTransaction(
  db: Database,
  userId: string,
  id: string,
  patch: Partial<{
    accountId: string;
    counterAccountId: string | null;
    categoryId: string | null;
    kind: TransactionRow['kind'];
    amount: number;
    occurredAt: Date;
    note: string | null;
    merchant: string | null;
  }>,
): Promise<TransactionRow | null> {
  const rows = await db
    .update(transactions)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(eq(transactions.userId, userId), eq(transactions.id, id), isNull(transactions.deletedAt)),
    )
    .returning();
  return rows[0] ?? null;
}

/** Hapus lunak. Pembukuan yang barisnya benar-benar hilang tidak dapat diaudit,
 *  dan yang tidak dapat diaudit tidak layak disebut pembukuan. */
export async function softDeleteTransaction(
  db: Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(transactions)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(transactions.userId, userId), eq(transactions.id, id), isNull(transactions.deletedAt)),
    )
    .returning({ id: transactions.id });
  return rows.length > 0;
}

/* ── agregat ─────────────────────────────────────────────────────────── */

export interface Totals {
  income: number;
  expense: number;
}

/**
 * Total pemasukan dan pengeluaran dalam rentang.
 *
 * Transfer TIDAK dihitung: memindahkan uang antar dompet sendiri bukan
 * pemasukan maupun pengeluaran, dan menghitungnya akan membuat setiap pengguna
 * yang menabung terlihat boros dua kali lipat.
 */
export async function totalsBetween(
  db: Database,
  userId: string,
  from: Date,
  to: Date,
): Promise<Totals> {
  const rows = await db
    .select({
      income: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.kind} = 'income' THEN ${transactions.amount} ELSE 0 END), 0)`,
      expense: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.kind} = 'expense' THEN ${transactions.amount} ELSE 0 END), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.deletedAt),
        gte(transactions.occurredAt, from),
        lte(transactions.occurredAt, to),
      ),
    );

  const row = rows[0];
  return { income: Number(row?.income ?? 0), expense: Number(row?.expense ?? 0) };
}

export interface CashflowRow {
  bucket: string;
  income: number;
  expense: number;
}

/**
 * Arus kas per hari atau per bulan.
 *
 * Pengelompokan dilakukan PostgreSQL, bukan JavaScript. Mengambil sepuluh ribu
 * baris untuk dijumlahkan di proses aplikasi memindahkan pekerjaan ke tempat
 * yang paling mahal dan paling jauh dari datanya.
 */
export async function cashflow(
  db: Database,
  userId: string,
  from: Date,
  to: Date,
  granularity: 'day' | 'month',
): Promise<CashflowRow[]> {
  /*
   * `sql.raw`, bukan interpolasi berparameter.
   *
   * `date_trunc($1, ...)` membuat GROUP BY dan daftar SELECT membawa parameter
   * pada posisi yang BERBEDA, dan PostgreSQL menolaknya karena kedua ekspresi
   * tidak lagi identik. Nilainya sendiri berasal dari union tertutup dua
   * anggota — bukan dari masukan pengguna — jadi tidak ada yang dapat
   * disuntikkan lewat sini.
   */
  const trunc = sql.raw(`date_trunc('${granularity}', "transactions"."occurred_at")`);
  const format = granularity === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';

  const rows = await db
    .select({
      bucket: sql<string>`to_char(${trunc}, ${format})`,
      income: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.kind} = 'income' THEN ${transactions.amount} ELSE 0 END), 0)`,
      expense: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.kind} = 'expense' THEN ${transactions.amount} ELSE 0 END), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.deletedAt),
        gte(transactions.occurredAt, from),
        lte(transactions.occurredAt, to),
      ),
    )
    .groupBy(trunc)
    .orderBy(trunc);

  return rows.map((row) => ({
    bucket: row.bucket,
    income: Number(row.income),
    expense: Number(row.expense),
  }));
}

export interface BreakdownRow {
  categoryId: string | null;
  categoryName: string | null;
  color: string | null;
  total: number;
}

export async function expenseByCategory(
  db: Database,
  userId: string,
  from: Date,
  to: Date,
  limit: number,
): Promise<BreakdownRow[]> {
  const rows = await db
    .select({
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      color: categories.color,
      total: sql<string>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.deletedAt),
        eq(transactions.kind, 'expense'),
        gte(transactions.occurredAt, from),
        lte(transactions.occurredAt, to),
      ),
    )
    .groupBy(transactions.categoryId, categories.name, categories.color)
    .orderBy(desc(sql`SUM(${transactions.amount})`))
    .limit(limit);

  return rows.map((row) => ({ ...row, total: Number(row.total) }));
}

/* ── anggaran ────────────────────────────────────────────────────────── */

export async function listBudgets(db: Database, userId: string): Promise<BudgetRow[]> {
  return db
    .select()
    .from(budgets)
    .where(and(eq(budgets.userId, userId), isNull(budgets.endsOn)))
    .orderBy(desc(budgets.amount));
}

export async function insertBudget(
  db: Database,
  userId: string,
  input: {
    categoryId: string;
    period: BudgetRow['period'];
    amount: number;
    currency: string;
    startsOn: string;
  },
): Promise<BudgetRow> {
  const rows = await db
    .insert(budgets)
    .values({ id: newId('bgt'), userId, ...input })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('insert anggaran tidak mengembalikan baris');
  return row;
}

/** Menutup anggaran berjalan alih-alih menimpanya — bulan yang sudah lewat
 *  tidak boleh berubah surut hanya karena batasnya dinaikkan hari ini. */
export async function closeBudget(
  db: Database,
  userId: string,
  id: string,
  endsOn: string,
): Promise<boolean> {
  const rows = await db
    .update(budgets)
    .set({ endsOn })
    .where(and(eq(budgets.userId, userId), eq(budgets.id, id), isNull(budgets.endsOn)))
    .returning({ id: budgets.id });
  return rows.length > 0;
}

export async function spentPerCategory(
  db: Database,
  userId: string,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      categoryId: transactions.categoryId,
      total: sql<string>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.deletedAt),
        eq(transactions.kind, 'expense'),
        gte(transactions.occurredAt, from),
        lte(transactions.occurredAt, to),
      ),
    )
    .groupBy(transactions.categoryId);

  const spent = new Map<string, number>();
  for (const row of rows) {
    /* Pengeluaran tanpa kategori memang ada dan sengaja diabaikan di sini —
       anggaran selalu terikat pada satu kategori. */
    if (row.categoryId !== null) spent.set(row.categoryId, Number(row.total));
  }
  return spent;
}

/* ── tujuan ──────────────────────────────────────────────────────────── */

export async function listGoals(db: Database, userId: string): Promise<GoalRow[]> {
  return db.select().from(goals).where(eq(goals.userId, userId)).orderBy(asc(goals.createdAt));
}

export async function insertGoal(
  db: Database,
  userId: string,
  input: {
    name: string;
    targetAmount: number;
    currency: string;
    targetDate: string | null;
    color: string | null;
  },
): Promise<GoalRow> {
  const rows = await db
    .insert(goals)
    .values({ id: newId('gol'), userId, ...input })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('insert tujuan tidak mengembalikan baris');
  return row;
}

/**
 * Menambah tabungan tujuan secara atomik.
 *
 * Penambahan dilakukan basis data (`saved_amount + $1`), bukan dengan membaca
 * lalu menulis di aplikasi. Dua permintaan yang berbarengan pada jalur baca-lalu-
 * tulis akan menghasilkan satu penambahan yang hilang tanpa jejak.
 */
export async function addToGoal(
  db: Database,
  userId: string,
  id: string,
  delta: number,
): Promise<GoalRow | null> {
  const rows = await db
    .update(goals)
    .set({
      savedAmount: sql`GREATEST(${goals.savedAmount} + ${delta}, 0)`,
      achievedAt: sql`CASE
        WHEN GREATEST(${goals.savedAmount} + ${delta}, 0) >= ${goals.targetAmount}
          THEN COALESCE(${goals.achievedAt}, now())
        ELSE NULL
      END`,
      updatedAt: new Date(),
    })
    .where(and(eq(goals.userId, userId), eq(goals.id, id)))
    .returning();
  return rows[0] ?? null;
}

export async function deleteGoal(db: Database, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(goals)
    .where(and(eq(goals.userId, userId), eq(goals.id, id)))
    .returning({ id: goals.id });
  return rows.length > 0;
}
