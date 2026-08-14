import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { users } from './schema.js';

/**
 * Buku besar: dompet, kategori, transaksi, anggaran, dan tujuan.
 *
 * UANG DISIMPAN SEBAGAI BILANGAN BULAT, TANPA KECUALI.
 *
 * `numeric` akan benar tetapi memaksa setiap penjumlahan melewati string;
 * `double precision` akan salah, dan salahnya tidak terlihat sampai laporan
 * bulanan meleset satu rupiah dan tidak ada yang bisa menjelaskan dari mana.
 * `bigint` menampung Rp 9,2 triliun kuadriliun — cukup untuk mata uang mana pun
 * yang akan ditangani sistem ini.
 *
 * Satuannya adalah SATUAN TERKECIL YANG BEREDAR, bukan eksponen ISO 4217. Untuk
 * IDR itu berarti rupiah utuh: sen tidak pernah dipakai dalam praktik pembayaran
 * Indonesia, dan menyimpan faktor seratus yang selalu nol hanya memindahkan
 * kesempatan salah kali ke setiap tempat yang membacanya. Eksponen per mata uang
 * hidup di `src/modules/ledger/money.ts`.
 */

export const accountKind = pgEnum('account_kind', [
  'cash',
  'bank',
  'ewallet',
  'card',
  'investment',
]);

export const categoryKind = pgEnum('category_kind', ['income', 'expense']);

export const transactionKind = pgEnum('transaction_kind', ['income', 'expense', 'transfer']);

export const budgetPeriod = pgEnum('budget_period', ['weekly', 'monthly', 'yearly']);

/** Dompet: kas, rekening bank, e-wallet, kartu, atau portofolio. */
export const walletAccounts = pgTable(
  'wallet_accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: accountKind('kind').notNull(),
    currency: text('currency').notNull().default('IDR'),
    /**
     * Saldo awal, bukan saldo berjalan.
     *
     * Saldo berjalan TIDAK disimpan: kolom yang harus selalu sepakat dengan
     * jumlah seluruh transaksi akan menyimpang pada kegagalan parsial pertama,
     * dan tidak ada yang menegakkan kesepakatannya. Saldo dihitung dari buku.
     */
    openingBalance: bigint('opening_balance', { mode: 'number' }).notNull().default(0),
    color: text('color'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('wallet_accounts_user').on(t.userId).where(sql`${t.archivedAt} IS NULL`),
    uniqueIndex('wallet_accounts_user_name').on(t.userId, t.name),
  ],
);

/**
 * Kategori.
 *
 * `userId` boleh NULL: baris itu adalah kategori bawaan sistem yang dipakai
 * bersama semua pengguna. Menyalin dua puluh baris bawaan ke setiap pendaftaran
 * berarti dua puluh baris yang tidak akan pernah bisa diperbaiki serentak.
 */
export const categories = pgTable(
  'categories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: categoryKind('kind').notNull(),
    icon: text('icon').notNull(),
    color: text('color').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('categories_user').on(t.userId, t.kind),
    /* Bawaan sistem unik per nama+jenis; milik pengguna unik dalam lingkupnya
       sendiri. Dua indeks parsial, karena NULL tidak pernah setara dengan NULL. */
    uniqueIndex('categories_system_name')
      .on(t.name, t.kind)
      .where(sql`${t.userId} IS NULL`),
    uniqueIndex('categories_user_name')
      .on(t.userId, t.name, t.kind)
      .where(sql`${t.userId} IS NOT NULL`),
  ],
);

/**
 * Transaksi.
 *
 * Transfer disimpan sebagai SATU baris dengan dua dompet, bukan sebagai
 * sepasang baris masuk dan keluar. Sepasang baris dapat kehilangan pasangannya;
 * satu baris tidak bisa setengah ada.
 */
export const transactions = pgTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => walletAccounts.id, { onDelete: 'restrict' }),
    /** Hanya untuk `transfer`: dompet tujuan. */
    counterAccountId: text('counter_account_id').references(() => walletAccounts.id, {
      onDelete: 'restrict',
    }),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    kind: transactionKind('kind').notNull(),
    /* Selalu POSITIF. Tanda ditentukan `kind`, bukan oleh tanda bilangan —
       jumlah negatif berjenis pemasukan tidak punya makna yang disepakati, dan
       laporan yang menjumlahkan keduanya akan diam-diam benar separuh waktu. */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('IDR'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    note: text('note'),
    merchant: text('merchant'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    /* Kueri terpanas: transaksi milik satu pengguna dalam satu rentang waktu,
       terbaru lebih dulu. Indeks ini yang menentukan apakah dasbor terasa
       seketika atau tidak. */
    index('transactions_user_time')
      .on(t.userId, t.occurredAt.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    index('transactions_account').on(t.accountId).where(sql`${t.deletedAt} IS NULL`),
    index('transactions_category').on(t.categoryId).where(sql`${t.deletedAt} IS NULL`),
    check('transactions_amount_positive', sql`${t.amount} > 0`),
    /* Transfer WAJIB punya dompet tujuan yang berbeda; yang bukan transfer
       tidak boleh punya. Ditegakkan basis data, bukan hanya lapisan layanan —
       satu jalur tulis yang lupa memeriksanya sudah cukup merusak seluruh
       laporan, dan jalur tulis akan bertambah. */
    check(
      'transactions_transfer_shape',
      sql`(${t.kind} = 'transfer' AND ${t.counterAccountId} IS NOT NULL AND ${t.counterAccountId} <> ${t.accountId})
          OR (${t.kind} <> 'transfer' AND ${t.counterAccountId} IS NULL)`,
    ),
  ],
);

/** Anggaran per kategori per periode. */
export const budgets = pgTable(
  'budgets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    period: budgetPeriod('period').notNull().default('monthly'),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('IDR'),
    /** Awal periode berlaku. Anggaran yang diubah menghasilkan baris baru
     *  supaya bulan yang sudah lewat tidak berubah surut. */
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('budgets_user_active').on(t.userId).where(sql`${t.endsOn} IS NULL`),
    uniqueIndex('budgets_one_active_per_category')
      .on(t.userId, t.categoryId)
      .where(sql`${t.endsOn} IS NULL`),
    check('budgets_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** Tujuan menabung. */
export const goals = pgTable(
  'goals',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    targetAmount: bigint('target_amount', { mode: 'number' }).notNull(),
    savedAmount: bigint('saved_amount', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull().default('IDR'),
    targetDate: date('target_date'),
    color: text('color'),
    achievedAt: timestamp('achieved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('goals_user').on(t.userId),
    uniqueIndex('goals_user_name').on(t.userId, t.name),
    check('goals_target_positive', sql`${t.targetAmount} > 0`),
    check('goals_saved_not_negative', sql`${t.savedAmount} >= 0`),
  ],
);

/**
 * Aturan berulang: tagihan dan pemasukan yang jatuh pada irama tetap.
 *
 * Yang disimpan adalah ATURANNYA, bukan kejadiannya. Menuliskan dua belas
 * baris transaksi di muka untuk cicilan setahun berarti dua belas baris yang
 * harus diperbaiki serentak ketika nominalnya berubah — dan yang di masa depan
 * akan ikut terhitung di saldo hari ini.
 */
export const recurringCadence = pgEnum('recurring_cadence', ['daily', 'weekly', 'monthly']);

export const recurringRules = pgTable(
  'recurring_rules',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => walletAccounts.id, { onDelete: 'cascade' }),
    counterAccountId: text('counter_account_id').references(() => walletAccounts.id, {
      onDelete: 'cascade',
    }),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    kind: transactionKind('kind').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('IDR'),
    merchant: text('merchant'),
    note: text('note'),
    cadence: recurringCadence('cadence').notNull(),
    /** Berapa satuan sekali. 1 = tiap hari/pekan/bulan. */
    interval: integer('interval').notNull().default(1),
    /**
     * Hari jangkar untuk irama bulanan, 1–31.
     *
     * TERPISAH dari `next_run_on`, dan itu bukan penyimpanan berlebih.
     * Tagihan tanggal 31 dijepit ke 28 di bulan Februari; kalau hasil jepitan
     * itu menjadi dasar bulan berikutnya, jatuh temponya bergeser maju
     * selamanya. Lihat `modules/ledger/schedule.ts`.
     */
    anchorDay: integer('anchor_day').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on'),
    /** Tanggal kejadian berikutnya yang BELUM dicatat. */
    nextRunOn: date('next_run_on').notNull(),
    lastRunOn: date('last_run_on'),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* Kueri pekerja: aturan mana pun, milik siapa pun, yang sudah jatuh tempo.
       Yang dijeda tidak masuk indeks sama sekali — aturan yang dimatikan tidak
       boleh membebani putaran yang berjalan tiap menit. */
    index('recurring_rules_due').on(t.nextRunOn).where(sql`${t.pausedAt} IS NULL`),
    index('recurring_rules_user').on(t.userId),
    check('recurring_rules_amount_positive', sql`${t.amount} > 0`),
    check('recurring_rules_interval_positive', sql`${t.interval} >= 1`),
    check('recurring_rules_anchor_range', sql`${t.anchorDay} BETWEEN 1 AND 31`),
    check(
      'recurring_rules_transfer_shape',
      sql`(${t.kind} = 'transfer' AND ${t.counterAccountId} IS NOT NULL AND ${t.counterAccountId} <> ${t.accountId})
          OR (${t.kind} <> 'transfer' AND ${t.counterAccountId} IS NULL)`,
    ),
  ],
);

/**
 * Kejadian yang SUDAH dicatat, satu baris per tanggal.
 *
 * Alasannya tunggal dan tidak dapat digantikan pemeriksaan di lapisan
 * layanan: indeks unik `(rule_id, occurred_on)`. Pekerja yang mati di tengah
 * putaran, dua instans API yang berjalan bersamaan, atau satu putaran yang
 * diulang setelah gangguan jaringan — ketiganya menghasilkan penulisan ganda
 * yang hanya dapat ditolak basis data. Tagihan sewa yang tercatat dua kali
 * adalah kesalahan yang baru ketahuan saat saldo tidak lagi cocok.
 */
export const recurringRuns = pgTable(
  'recurring_runs',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id')
      .notNull()
      .references(() => recurringRules.id, { onDelete: 'cascade' }),
    occurredOn: date('occurred_on').notNull(),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('recurring_runs_once').on(t.ruleId, t.occurredOn)],
);

export const walletAccountsRelations = relations(walletAccounts, ({ one, many }) => ({
  user: one(users, { fields: [walletAccounts.userId], references: [users.id] }),
  transactions: many(transactions),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  account: one(walletAccounts, {
    fields: [transactions.accountId],
    references: [walletAccounts.id],
  }),
  category: one(categories, { fields: [transactions.categoryId], references: [categories.id] }),
}));

export type WalletAccountRow = typeof walletAccounts.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type BudgetRow = typeof budgets.$inferSelect;
export type GoalRow = typeof goals.$inferSelect;
export type RecurringRuleRow = typeof recurringRules.$inferSelect;
export type RecurringRunRow = typeof recurringRuns.$inferSelect;
