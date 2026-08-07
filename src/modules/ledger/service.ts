import { DomainError } from '../../contracts/domain.js';
import type {
  Budget,
  CashflowPoint,
  Category,
  CategoryBreakdown,
  DashboardSummary,
  Goal,
  Transaction,
  TransactionPage,
  WalletAccount,
} from '../../contracts/ledger.js';
import type { Database } from '../../platform/db/client.js';
import type {
  BudgetRow,
  CategoryRow,
  GoalRow,
  TransactionRow,
  WalletAccountRow,
} from '../../platform/db/ledger.js';
import { DEFAULT_CURRENCY, assertAmount, isSupportedCurrency } from './money.js';
import { daysBack, monthRange, periodStart, previousMonthRange, toDateString } from './periods.js';
import * as repo from './repository.js';

/**
 * Aturan buku besar.
 *
 * Semua yang memutuskan ada di sini; semua yang bertanya ada di `repository`.
 * Batasnya dijaga ketat karena inilah lapisan yang harus benar — kesalahan di
 * repositori menghasilkan galat, kesalahan di sini menghasilkan angka yang
 * salah namun tampak wajar.
 */

export interface LedgerDeps {
  db: Database;
}

/** Berapa banyak transaksi yang boleh diminta sekaligus. Di atas ini permintaan
 *  tunggal dapat memakan memori seluruh proses. */
const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;
const TOP_CATEGORIES = 6;
const CASHFLOW_DAYS = 30;

/* ── pemetaan ────────────────────────────────────────────────────────── */

function toAccount(row: WalletAccountRow, balance: number): WalletAccount {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    currency: row.currency,
    openingBalance: row.openingBalance,
    balance,
    color: row.color,
    archived: row.archivedAt !== null,
  };
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    icon: row.icon,
    color: row.color,
    system: row.userId === null,
  };
}

function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    accountId: row.accountId,
    counterAccountId: row.counterAccountId,
    categoryId: row.categoryId,
    kind: row.kind,
    amount: row.amount,
    currency: row.currency,
    occurredAt: row.occurredAt.getTime(),
    note: row.note,
    merchant: row.merchant,
  };
}

function toBudget(row: BudgetRow, spent: number): Budget {
  return {
    id: row.id,
    categoryId: row.categoryId,
    period: row.period,
    amount: row.amount,
    currency: row.currency,
    startsOn: row.startsOn,
    spent,
  };
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    name: row.name,
    targetAmount: row.targetAmount,
    savedAmount: row.savedAmount,
    currency: row.currency,
    targetDate: row.targetDate,
    color: row.color,
    achieved: row.achievedAt !== null,
  };
}

/* ── dompet ──────────────────────────────────────────────────────────── */

export async function listAccounts(
  deps: LedgerDeps,
  userId: string,
  includeArchived = false,
): Promise<WalletAccount[]> {
  const [rows, balances] = await Promise.all([
    repo.listAccounts(deps.db, userId, includeArchived),
    repo.balances(deps.db, userId),
  ]);

  return rows.map((row) => toAccount(row, balances.get(row.id) ?? row.openingBalance));
}

export async function createAccount(
  deps: LedgerDeps,
  userId: string,
  input: {
    name: string;
    kind: WalletAccountRow['kind'];
    currency?: string | undefined;
    openingBalance?: number | undefined;
    color?: string | undefined;
  },
): Promise<WalletAccount> {
  const currency = input.currency ?? DEFAULT_CURRENCY;
  if (!isSupportedCurrency(currency)) throw new DomainError('invalid_input', 'mata uang tidak didukung');

  const opening = input.openingBalance ?? 0;
  /* Saldo awal BOLEH nol dan boleh negatif — kartu kredit dimulai dari utang.
     `assertAmount` menolak nol, jadi ia tidak dipakai di sini; yang harus benar
     hanyalah bahwa nilainya bilangan bulat. */
  if (!Number.isSafeInteger(opening)) throw new DomainError('invalid_input', 'saldo awal tidak valid');

  const row = await repo.insertAccount(deps.db, userId, {
    name: input.name.trim(),
    kind: input.kind,
    currency,
    openingBalance: opening,
    color: input.color ?? null,
  });

  return toAccount(row, opening);
}

export async function updateAccount(
  deps: LedgerDeps,
  userId: string,
  id: string,
  patch: {
    name?: string | undefined;
    kind?: WalletAccountRow['kind'] | undefined;
    color?: string | null | undefined;
    archived?: boolean | undefined;
  },
): Promise<WalletAccount> {
  const row = await repo.updateAccount(deps.db, userId, id, {
    ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
    ...(patch.kind === undefined ? {} : { kind: patch.kind }),
    ...(patch.color === undefined ? {} : { color: patch.color }),
    ...(patch.archived === undefined ? {} : { archivedAt: patch.archived ? new Date() : null }),
  });

  if (!row) throw new DomainError('not_found', 'dompet tidak ditemukan');

  const balances = await repo.balances(deps.db, userId);
  return toAccount(row, balances.get(row.id) ?? row.openingBalance);
}

/* ── kategori ────────────────────────────────────────────────────────── */

export async function listCategories(deps: LedgerDeps, userId: string): Promise<Category[]> {
  return (await repo.listCategories(deps.db, userId)).map(toCategory);
}

export async function createCategory(
  deps: LedgerDeps,
  userId: string,
  input: { name: string; kind: CategoryRow['kind']; icon: string; color: string },
): Promise<Category> {
  return toCategory(
    await repo.insertCategory(deps.db, userId, { ...input, name: input.name.trim() }),
  );
}

export async function updateCategory(
  deps: LedgerDeps,
  userId: string,
  id: string,
  patch: { name?: string | undefined; icon?: string | undefined; color?: string | undefined },
): Promise<Category> {
  /* Kategori bawaan sistem tidak dapat diubah: ia dibagi seluruh pengguna, dan
     satu perubahan akan mengubah pembukuan semua orang. */
  const row = await repo.updateOwnCategory(deps.db, userId, id, {
    ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
    ...(patch.icon === undefined ? {} : { icon: patch.icon }),
    ...(patch.color === undefined ? {} : { color: patch.color }),
  });

  if (!row) throw new DomainError('not_found', 'kategori tidak ditemukan');
  return toCategory(row);
}

export async function archiveCategory(
  deps: LedgerDeps,
  userId: string,
  id: string,
): Promise<void> {
  const row = await repo.updateOwnCategory(deps.db, userId, id, { archivedAt: new Date() });
  if (!row) throw new DomainError('not_found', 'kategori tidak ditemukan');
}

/* ── transaksi ───────────────────────────────────────────────────────── */

export interface TransactionQuery {
  accountId?: string | undefined;
  categoryId?: string | undefined;
  kind?: TransactionRow['kind'] | undefined;
  from?: number | undefined;
  to?: number | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function listTransactions(
  deps: LedgerDeps,
  userId: string,
  query: TransactionQuery,
): Promise<TransactionPage> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);

  /* Diminta satu lebih banyak dari yang akan dikembalikan. Itulah cara mengetahui
     ada halaman berikutnya tanpa kueri COUNT kedua yang memindai seluruh tabel. */
  const rows = await repo.listTransactions(deps.db, userId, {
    accountId: query.accountId,
    categoryId: query.categoryId,
    kind: query.kind,
    from: query.from === undefined ? undefined : new Date(query.from),
    to: query.to === undefined ? undefined : new Date(query.to),
    cursor: query.cursor,
    limit: limit + 1,
  });

  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    items: page.map(toTransaction),
    nextCursor: rows.length > limit && last ? repo.encodeCursor(last) : null,
  };
}

export interface TransactionInput {
  accountId: string;
  counterAccountId?: string | undefined;
  categoryId?: string | undefined;
  kind: TransactionRow['kind'];
  amount: number;
  occurredAt: number;
  note?: string | undefined;
  merchant?: string | undefined;
}

/**
 * Memeriksa bentuk transaksi sebelum menulis.
 *
 * Basis data juga menegakkannya lewat CHECK, dan itu disengaja: pemeriksaan di
 * sini menghasilkan pesan yang berguna, pemeriksaan di sana menjamin tidak ada
 * jalur tulis mana pun yang bisa melewatinya. Keduanya diperlukan.
 */
async function resolveShape(
  deps: LedgerDeps,
  userId: string,
  input: TransactionInput,
): Promise<{ counterAccountId: string | null; categoryId: string | null; currency: string }> {
  assertAmount(input.amount);

  const account = await repo.findAccount(deps.db, userId, input.accountId);
  if (!account) throw new DomainError('not_found', 'dompet tidak ditemukan');

  if (input.kind === 'transfer') {
    if (!input.counterAccountId) throw new DomainError('invalid_input', 'transfer butuh dompet tujuan');
    if (input.counterAccountId === input.accountId) {
      throw new DomainError('invalid_input', 'dompet tujuan harus berbeda');
    }

    const counter = await repo.findAccount(deps.db, userId, input.counterAccountId);
    if (!counter) throw new DomainError('not_found', 'dompet tujuan tidak ditemukan');

    /* Transfer lintas mata uang membutuhkan kurs, dan kurs yang tidak dicatat
       bersama transaksinya membuat saldo historis tidak dapat direkonstruksi.
       Ditolak sampai M6 membawa pencatatan kurs. */
    if (counter.currency !== account.currency) {
      throw new DomainError('invalid_input', 'transfer antar mata uang belum didukung');
    }

    /* Transfer tidak berkategori: ia bukan pemasukan maupun pengeluaran, dan
       kategori pada transfer akan muncul di laporan sebagai belanja hantu. */
    return { counterAccountId: input.counterAccountId, categoryId: null, currency: account.currency };
  }

  if (input.counterAccountId) {
    throw new DomainError('invalid_input', 'dompet tujuan hanya untuk transfer');
  }

  if (input.categoryId) {
    const category = await repo.findCategory(deps.db, userId, input.categoryId);
    if (!category) throw new DomainError('not_found', 'kategori tidak ditemukan');
    if (category.kind !== input.kind) {
      throw new DomainError('invalid_input', 'jenis kategori tidak cocok dengan jenis transaksi');
    }
  }

  return {
    counterAccountId: null,
    categoryId: input.categoryId ?? null,
    currency: account.currency,
  };
}

export async function createTransaction(
  deps: LedgerDeps,
  userId: string,
  input: TransactionInput,
): Promise<Transaction> {
  const shape = await resolveShape(deps, userId, input);

  return toTransaction(
    await repo.insertTransaction(deps.db, userId, {
      accountId: input.accountId,
      counterAccountId: shape.counterAccountId,
      categoryId: shape.categoryId,
      kind: input.kind,
      amount: input.amount,
      currency: shape.currency,
      occurredAt: new Date(input.occurredAt),
      note: input.note?.trim() ?? null,
      merchant: input.merchant?.trim() ?? null,
    }),
  );
}

export async function updateTransaction(
  deps: LedgerDeps,
  userId: string,
  id: string,
  input: TransactionInput,
): Promise<Transaction> {
  const existing = await repo.findTransaction(deps.db, userId, id);
  if (!existing) throw new DomainError('not_found', 'transaksi tidak ditemukan');

  const shape = await resolveShape(deps, userId, input);

  const row = await repo.updateTransaction(deps.db, userId, id, {
    accountId: input.accountId,
    counterAccountId: shape.counterAccountId,
    categoryId: shape.categoryId,
    kind: input.kind,
    amount: input.amount,
    occurredAt: new Date(input.occurredAt),
    note: input.note?.trim() ?? null,
    merchant: input.merchant?.trim() ?? null,
  });

  if (!row) throw new DomainError('not_found', 'transaksi tidak ditemukan');
  return toTransaction(row);
}

export async function deleteTransaction(
  deps: LedgerDeps,
  userId: string,
  id: string,
): Promise<void> {
  const removed = await repo.softDeleteTransaction(deps.db, userId, id);
  if (!removed) throw new DomainError('not_found', 'transaksi tidak ditemukan');
}

/* ── anggaran ────────────────────────────────────────────────────────── */

export async function listBudgets(
  deps: LedgerDeps,
  userId: string,
  now = new Date(),
): Promise<Budget[]> {
  const rows = await repo.listBudgets(deps.db, userId);
  if (rows.length === 0) return [];

  /*
   * Terpakai dihitung per PERIODE MASING-MASING anggaran, bukan per bulan
   * berjalan untuk semuanya. Anggaran mingguan yang diukur terhadap pengeluaran
   * sebulan akan selalu terlihat jebol.
   */
  const perPeriod = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (perPeriod.has(row.period)) continue;
    const range = periodStart(row.period, now);
    perPeriod.set(row.period, await repo.spentPerCategory(deps.db, userId, range.from, range.to));
  }

  return rows.map((row) =>
    toBudget(row, perPeriod.get(row.period)?.get(row.categoryId) ?? 0),
  );
}

export async function createBudget(
  deps: LedgerDeps,
  userId: string,
  input: {
    categoryId: string;
    period: BudgetRow['period'];
    amount: number;
    currency?: string | undefined;
  },
  now = new Date(),
): Promise<Budget> {
  assertAmount(input.amount);

  const category = await repo.findCategory(deps.db, userId, input.categoryId);
  if (!category) throw new DomainError('not_found', 'kategori tidak ditemukan');
  if (category.kind !== 'expense') {
    throw new DomainError('invalid_input', 'anggaran hanya untuk kategori pengeluaran');
  }

  const currency = input.currency ?? DEFAULT_CURRENCY;
  if (!isSupportedCurrency(currency)) throw new DomainError('invalid_input', 'mata uang tidak didukung');

  const row = await repo.insertBudget(deps.db, userId, {
    categoryId: input.categoryId,
    period: input.period,
    amount: input.amount,
    currency,
    startsOn: toDateString(periodStart(input.period, now).from),
  });

  const range = periodStart(row.period, now);
  const spent = await repo.spentPerCategory(deps.db, userId, range.from, range.to);
  return toBudget(row, spent.get(row.categoryId) ?? 0);
}

export async function closeBudget(
  deps: LedgerDeps,
  userId: string,
  id: string,
  now = new Date(),
): Promise<void> {
  const closed = await repo.closeBudget(deps.db, userId, id, toDateString(now));
  if (!closed) throw new DomainError('not_found', 'anggaran tidak ditemukan');
}

/* ── tujuan ──────────────────────────────────────────────────────────── */

export async function listGoals(deps: LedgerDeps, userId: string): Promise<Goal[]> {
  return (await repo.listGoals(deps.db, userId)).map(toGoal);
}

export async function createGoal(
  deps: LedgerDeps,
  userId: string,
  input: {
    name: string;
    targetAmount: number;
    currency?: string | undefined;
    targetDate?: string | undefined;
    color?: string | undefined;
  },
): Promise<Goal> {
  assertAmount(input.targetAmount);

  const currency = input.currency ?? DEFAULT_CURRENCY;
  if (!isSupportedCurrency(currency)) throw new DomainError('invalid_input', 'mata uang tidak didukung');

  return toGoal(
    await repo.insertGoal(deps.db, userId, {
      name: input.name.trim(),
      targetAmount: input.targetAmount,
      currency,
      targetDate: input.targetDate ?? null,
      color: input.color ?? null,
    }),
  );
}

export async function contributeToGoal(
  deps: LedgerDeps,
  userId: string,
  id: string,
  delta: number,
): Promise<Goal> {
  if (!Number.isSafeInteger(delta) || delta === 0) {
    throw new DomainError('invalid_input', 'jumlah kontribusi tidak valid');
  }

  const row = await repo.addToGoal(deps.db, userId, id, delta);
  if (!row) throw new DomainError('not_found', 'tujuan tidak ditemukan');
  return toGoal(row);
}

export async function deleteGoal(deps: LedgerDeps, userId: string, id: string): Promise<void> {
  const removed = await repo.deleteGoal(deps.db, userId, id);
  if (!removed) throw new DomainError('not_found', 'tujuan tidak ditemukan');
}

/* ── analitik ────────────────────────────────────────────────────────── */

export async function cashflow(
  deps: LedgerDeps,
  userId: string,
  options: { days?: number | undefined; months?: number | undefined },
  now = new Date(),
): Promise<CashflowPoint[]> {
  if (options.months !== undefined) {
    /* Mundur dari AWAL bulan berjalan, bukan dari hari ini — mundur dari tanggal
       31 akan melewati Februari seluruhnya. */
    const start = new Date(monthRange(now).from);
    start.setUTCMonth(start.getUTCMonth() - (options.months - 1));
    return repo.cashflow(deps.db, userId, start, now, 'month');
  }

  const range = daysBack(options.days ?? CASHFLOW_DAYS, now);
  return repo.cashflow(deps.db, userId, range.from, range.to, 'day');
}

export async function dashboard(
  deps: LedgerDeps,
  userId: string,
  now = new Date(),
): Promise<DashboardSummary> {
  const thisMonth = monthRange(now);
  const lastMonth = previousMonthRange(now);
  const window = daysBack(CASHFLOW_DAYS, now);

  const [accounts, monthTotals, previousTotals, flow, breakdown, page, budgetList, goalList] =
    await Promise.all([
      listAccounts(deps, userId),
      repo.totalsBetween(deps.db, userId, thisMonth.from, thisMonth.to),
      repo.totalsBetween(deps.db, userId, lastMonth.from, lastMonth.to),
      repo.cashflow(deps.db, userId, window.from, window.to, 'day'),
      repo.expenseByCategory(deps.db, userId, thisMonth.from, thisMonth.to, TOP_CATEGORIES),
      listTransactions(deps, userId, { limit: 8 }),
      listBudgets(deps, userId, now),
      listGoals(deps, userId),
    ]);

  const topCategories: CategoryBreakdown[] = breakdown.map((row) => ({
    categoryId: row.categoryId,
    categoryName: row.categoryName ?? 'Tanpa kategori',
    color: row.color ?? '#71717a',
    total: row.total,
  }));

  return {
    currency: accounts[0]?.currency ?? DEFAULT_CURRENCY,
    netWorth: accounts.reduce((total, account) => total + account.balance, 0),
    monthIncome: monthTotals.income,
    monthExpense: monthTotals.expense,
    /* `null`, bukan nol, ketika belum ada bulan pembanding — nol berarti "sama
       seperti bulan lalu", dan itu pernyataan yang belum bisa dibuat. */
    expenseDelta:
      previousTotals.income === 0 && previousTotals.expense === 0
        ? null
        : monthTotals.expense - previousTotals.expense,
    accounts,
    recent: page.items,
    cashflow: flow,
    topCategories,
    budgets: budgetList,
    goals: goalList,
  };
}
