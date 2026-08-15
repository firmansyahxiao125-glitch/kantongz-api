/**
 * Kontrak buku besar.
 *
 * Bentuk-bentuk ini dibagikan apa adanya ke aplikasi mobile dan web. Seluruh
 * jumlah adalah BILANGAN BULAT dalam satuan terkecil mata uangnya yang beredar
 * (`src/modules/ledger/money.ts`) — tidak ada satu pun pecahan yang menyeberangi
 * batas HTTP, karena pecahan yang menyeberang akan dibaca sebagai `double` di
 * sisi lain dan pembukuan yang dijumlahkan sebagai `double` salah diam-diam.
 */

export type AccountKind = 'cash' | 'bank' | 'ewallet' | 'card' | 'investment';
export type CategoryKind = 'income' | 'expense';
export type TransactionKind = 'income' | 'expense' | 'transfer';
export type BudgetPeriod = 'weekly' | 'monthly' | 'yearly';

export interface WalletAccount {
  id: string;
  name: string;
  kind: AccountKind;
  currency: string;
  openingBalance: number;
  /** Dihitung dari buku, tidak pernah disimpan. */
  balance: number;
  color: string | null;
  archived: boolean;
}

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  icon: string;
  color: string;
  /** Kategori bawaan sistem tidak dapat diubah atau dihapus pengguna. */
  system: boolean;
}

export interface Transaction {
  id: string;
  accountId: string;
  counterAccountId: string | null;
  categoryId: string | null;
  kind: TransactionKind;
  /** Selalu positif. Arah ditentukan `kind`. */
  amount: number;
  currency: string;
  /** Epoch milidetik. */
  occurredAt: number;
  note: string | null;
  merchant: string | null;
  /**
   * Rincian pemecahan ke beberapa kategori. F3.
   *
   * `null` — bukan `[]` — bila transaksinya tidak dipecah. Bedanya
   * disengaja: larik kosong berarti "dipecah menjadi nol bagian", keadaan
   * yang tidak sah dan tidak pernah ada. `null` berarti "tidak dipecah", dan
   * `categoryId` di atas adalah seluruh ceritanya.
   */
  splits: TransactionSplit[] | null;
}

export interface TransactionSplit {
  id: string;
  categoryId: string;
  /** Rupiah bulat, selalu positif. Jumlah seluruhnya = `amount` transaksi. */
  amount: number;
  note: string | null;
}

export interface TransactionPage {
  items: Transaction[];
  /** `null` berarti tidak ada halaman berikutnya. */
  nextCursor: string | null;
}

export interface Budget {
  id: string;
  categoryId: string;
  period: BudgetPeriod;
  amount: number;
  currency: string;
  startsOn: string;
  /** Terpakai dalam periode berjalan, dihitung dari transaksi. */
  spent: number;
  /** Sisa periode lalu ikut ke periode ini. */
  rollover: boolean;
  /**
   * Bawaan dari periode-periode sebelumnya. Positif berarti sisa, NEGATIF
   * berarti utang dari periode yang jebol. Selalu 0 ketika `rollover` mati.
   */
  carryOver: number;
  /** `amount + carryOver`, tidak pernah di bawah nol. Ini yang diukur `spent`. */
  limit: number;
}

export interface Goal {
  id: string;
  name: string;
  targetAmount: number;
  savedAmount: number;
  currency: string;
  targetDate: string | null;
  color: string | null;
  achieved: boolean;
}

/** Nasib satu baris impor. `imported` pada pratinjau berarti "akan masuk". */
export interface ImportOutcome {
  index: number;
  status: 'imported' | 'duplicate' | 'error';
  reason: string | null;
}

export interface ImportReport {
  total: number;
  imported: number;
  duplicate: number;
  failed: number;
  /** `true` berarti tidak ada satu baris pun yang ditulis. */
  dryRun: boolean;
  results: ImportOutcome[];
}

export type Cadence = 'daily' | 'weekly' | 'monthly';

/**
 * Aturan berulang: tagihan atau pemasukan yang jatuh pada irama tetap.
 *
 * `nextRunOn` adalah tanggal KALENDER (`YYYY-MM-DD`), bukan cap waktu, karena
 * "tanggal 1 setiap bulan" adalah pernyataan tentang kalender. Perubahannya
 * menjadi titik waktu terjadi sekali, saat transaksinya ditulis.
 */
export interface RecurringRule {
  id: string;
  name: string;
  accountId: string;
  counterAccountId: string | null;
  categoryId: string | null;
  kind: TransactionKind;
  amount: number;
  currency: string;
  merchant: string | null;
  note: string | null;
  cadence: Cadence;
  interval: number;
  startsOn: string;
  endsOn: string | null;
  nextRunOn: string;
  lastRunOn: string | null;
  paused: boolean;
  /** Berapa transaksi yang sudah dilahirkan aturan ini. */
  postedCount: number;
}

export interface CashflowPoint {
  /** `YYYY-MM-DD` untuk harian, `YYYY-MM` untuk bulanan. */
  bucket: string;
  income: number;
  expense: number;
}

export interface CategoryBreakdown {
  categoryId: string | null;
  categoryName: string;
  color: string;
  total: number;
}

export interface DashboardSummary {
  currency: string;
  /** Saldo seluruh dompet aktif. */
  netWorth: number;
  monthIncome: number;
  monthExpense: number;
  /** Selisih pengeluaran terhadap bulan sebelumnya, dalam satuan yang sama.
   *  `null` bila belum ada bulan pembanding. */
  expenseDelta: number | null;
  accounts: WalletAccount[];
  recent: Transaction[];
  cashflow: CashflowPoint[];
  topCategories: CategoryBreakdown[];
  budgets: Budget[];
  goals: Goal[];
}
