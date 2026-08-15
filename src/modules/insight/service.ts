import { dompetTerlihat } from '../ledger/akses-dompet.js';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';

import type {
  CashflowProjection,
  CategorySuggestion,
  Insight,
  InsightDigest,
  RecurringCharge,
} from '../../contracts/insight.js';
import type { Database } from '../../platform/db/client.js';
import { categories, transactions } from '../../platform/db/ledger.js';
import { DomainError } from '../../contracts/domain.js';
import * as ledger from '../ledger/repository.js';
import { daysBack, periodStart } from '../ledger/periods.js';
import { findAmountAnomalies, findSubscriptions, monthlyCost } from './anomaly.js';
import { projectCashflow, daysUntilEmpty } from './forecast.js';
import { matchRule } from './rules.js';

/**
 * Lapisan wawasan. ROADMAP M9–M12.
 *
 * SELURUHNYA deterministik. Tidak ada model, tidak ada panggilan jaringan, dan
 * karena itu tidak ada biaya per pengguna maupun latensi yang tidak dapat
 * diprediksi. Yang membutuhkan model — ringkasan naratif M11 dan chat M13 —
 * hidup di lapisan terpisah dan tidak menghalangi apa pun di sini.
 */

export interface InsightDeps {
  db: Database;
}

/** Jendela riwayat untuk analisis. Cukup panjang untuk menangkap pola bulanan
 *  beberapa siklus, cukup pendek untuk masih menggambarkan kebiasaan sekarang. */
const HISTORY_DAYS = 180;

/** Ambang peringatan anggaran. Di 85% masih ada waktu bertindak; di 100%
 *  peringatannya hanya memberitahu sesuatu yang sudah terjadi. */
const BUDGET_WARN_RATIO = 0.85;

/** Berapa hari lagi saldo menyentuh nol sebelum itu disebut kritis. */
const RUNWAY_CRITICAL_DAYS = 30;

function idr(value: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value);
}

interface Sample {
  id: string;
  categoryId: string | null;
  amount: number;
  occurredAt: number;
  merchant: string | null;
}

/** Pengeluaran dalam jendela riwayat. Pemasukan dan transfer tidak ikut:
 *  keduanya bukan kebiasaan belanja, dan mencampurnya merusak setiap statistik
 *  di bawah ini. */
async function expenseHistory(deps: InsightDeps, userId: string, now: Date): Promise<Sample[]> {
  const window = daysBack(HISTORY_DAYS, now);

  const rows = await deps.db
    .select({
      id: transactions.id,
      categoryId: transactions.categoryId,
      amount: transactions.amount,
      occurredAt: transactions.occurredAt,
      merchant: transactions.merchant,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.deletedAt),
        eq(transactions.kind, 'expense'),
        gte(transactions.occurredAt, window.from),
      ),
    )
    .orderBy(desc(transactions.occurredAt));

  return rows.map((row) => ({ ...row, occurredAt: row.occurredAt.getTime() }));
}

/* ── M9: usulan kategori ─────────────────────────────────────────────── */

/**
 * Mengusulkan kategori untuk transaksi yang belum berkategori.
 *
 * Aturan lebih dulu, dan untuk sekarang hanya aturan. Yang tidak cocok
 * dibiarkan tanpa usulan — menebak akan menghasilkan kategori yang salah dengan
 * percaya diri, dan pengguna tidak akan memeriksanya. Lapisan model M9 tahap dua
 * menangani sisanya ketika kredensialnya tersedia.
 */
export async function suggestCategories(
  deps: InsightDeps,
  userId: string,
  limit = 50,
): Promise<CategorySuggestion[]> {
  const rows = await deps.db
    .select({
      id: transactions.id,
      kind: transactions.kind,
      merchant: transactions.merchant,
      note: transactions.note,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.deletedAt),
        isNull(transactions.categoryId),
      ),
    )
    .orderBy(desc(transactions.occurredAt))
    .limit(limit);

  if (rows.length === 0) return [];

  const all = await ledger.listCategories(deps.db, userId);
  const byName = new Map(all.map((c) => [c.name, c]));

  const suggestions: CategorySuggestion[] = [];

  for (const row of rows) {
    /* Transfer tidak berkategori — ia bukan pemasukan maupun pengeluaran. */
    if (row.kind === 'transfer') continue;

    const match = matchRule(`${row.merchant ?? ''} ${row.note ?? ''}`);
    if (!match) continue;

    const category = byName.get(match.category);
    /* Aturan menyebut kategori yang tidak ada di daftar pengguna — mungkin
       diarsipkan. Dilewati alih-alih mengusulkan id yang akan ditolak. */
    if (!category || category.kind !== row.kind) continue;

    suggestions.push({
      transactionId: row.id,
      categoryId: category.id,
      categoryName: category.name,
      reason: `Cocok dengan "${match.matched}"`,
    });
  }

  return suggestions;
}

/**
 * Menerapkan satu usulan.
 *
 * Penerapannya EKSPLISIT dan satu per satu, bukan otomatis di latar belakang.
 * Kategorisasi yang berubah sendiri membuat laporan bulan lalu berbeda setiap
 * kali dibuka, dan pengguna kehilangan kepercayaan pada seluruh angkanya.
 */
export async function applySuggestion(
  deps: InsightDeps,
  userId: string,
  transactionId: string,
  categoryId: string,
): Promise<void> {
  const category = await ledger.findCategory(deps.db, userId, categoryId);
  if (!category) throw new DomainError('not_found', 'kategori tidak ditemukan');

  const updated = await ledger.updateTransaction(deps.db, userId, transactionId, { categoryId });
  if (!updated) throw new DomainError('not_found', 'transaksi tidak ditemukan');

  if (updated.kind !== category.kind) {
    throw new DomainError('invalid_input', 'jenis kategori tidak cocok dengan jenis transaksi');
  }
}

/* ── M10 + M12: ringkasan wawasan ────────────────────────────────────── */

export async function digest(
  deps: InsightDeps,
  userId: string,
  now = new Date(),
): Promise<InsightDigest> {
  const [history, balances, budgets, categoryRows] = await Promise.all([
    expenseHistory(deps, userId, now),
    ledger.balances(deps.db, userId, await dompetTerlihat(deps.db, userId)),
    ledger.listBudgets(deps.db, userId),
    deps.db
      .select({ id: categories.id, name: categories.name })
      .from(categories),
  ]);

  const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]));
  const insights: Insight[] = [];

  /* ── nominal janggal ── */
  for (const anomaly of findAmountAnomalies(history).slice(0, 5)) {
    const sample = history.find((s) => s.id === anomaly.transactionId);
    const nama = sample?.categoryId ? (categoryName.get(sample.categoryId) ?? 'kategori ini') : 'kategori ini';

    insights.push({
      id: `anomaly:${anomaly.transactionId}`,
      kind: 'anomaly',
      severity: 'warning',
      title: 'Pengeluaran jauh di atas kebiasaan',
      body: `${idr(anomaly.amount)} untuk ${nama} — jauh di atas rata-ratamu ${idr(anomaly.categoryMean)}.`,
      reason: `${String(anomaly.zScore)} simpangan baku di atas rata-rata ${nama} enam bulan terakhir.`,
      amount: anomaly.amount,
      transactionId: anomaly.transactionId,
      categoryId: sample?.categoryId ?? null,
    });
  }

  /* ── langganan hantu ── */
  const subscriptions = findSubscriptions(history, now.getTime());
  const recurring: RecurringCharge[] = subscriptions.map((s) => ({
    merchant: s.merchant,
    amount: s.amount,
    intervalDays: s.intervalDays,
    occurrences: s.occurrences,
    lastChargedAt: s.lastChargedAt,
    monthlyCost: monthlyCost(s),
    dormant: s.dormant,
  }));

  const hantu = recurring.filter((r) => r.dormant);
  if (hantu.length > 0) {
    const total = hantu.reduce((sum, r) => sum + r.monthlyCost, 0);

    insights.push({
      id: 'ghost:all',
      kind: 'ghost_subscription',
      severity: 'warning',
      title: `${String(hantu.length)} langganan berjalan terus`,
      body: `${hantu.map((r) => r.merchant).join(', ')} — total ${idr(total)} per bulan.`,
      reason: `Ditagih ${String(hantu[0]?.occurrences ?? 0)} kali dengan nominal yang tidak pernah berubah. Periksa apakah masih kamu pakai.`,
      amount: total,
      transactionId: null,
      categoryId: null,
    });
  }

  /*
   * ── anggaran berisiko ──
   *
   * TERPAKAI DIHITUNG PER PERIODE MASING-MASING ANGGARAN.
   *
   * Sebelumnya baris ini memakai satu jendela bergulir 30 hari untuk SEMUA
   * anggaran, lalu menyebut hasilnya "% batas periode berjalan". Keduanya tidak
   * pernah bisa benar sekaligus, dan akibatnya terukur di peramban:
   *
   *   halaman Anggaran : Belanja Rp 1.739.000 / Rp 1.200.000  (145%)
   *   halaman Wawasan  : "Sudah Rp 2.049.000 dari batas Rp 1.200.000" (171%)
   *
   * Satu anggaran, dua angka, dan keduanya mengaku periode berjalan. Selisih
   * Rp 310.000 itu satu transaksi berumur 28 hari — di dalam jendela 30 hari,
   * di luar bulan berjalan.
   *
   * Bagi anggaran MINGGUAN cacatnya jauh lebih parah daripada tidak konsisten:
   * pengeluaran sebulan diadu dengan batas sepekan, jadi anggaran mingguan yang
   * sehat pun dilaporkan jebol SELAMANYA. Peringatan yang selalu menyala adalah
   * peringatan yang berhenti dibaca — dan ia menyeret seluruh halaman Wawasan
   * ikut tidak dipercaya.
   *
   * `ledger/service.ts` sudah menuliskan aturannya dan alasannya persis sama
   * ("Anggaran mingguan yang diukur terhadap pengeluaran sebulan akan selalu
   * terlihat jebol") — modul ini mengimpor REPOSITORY, jadi `spent` yang sudah
   * benar itu tidak pernah ikut sampai ke sini. Yang diperbaiki: memakai
   * jendela yang sama, bukan menyalin angkanya.
   *
   * Satu kueri per PERIODE UNIK, bukan per anggaran — sepuluh anggaran bulanan
   * tetap satu kueri.
   */
  const terpakaiPerPeriode = new Map<string, Map<string, number>>();
  for (const budget of budgets) {
    if (terpakaiPerPeriode.has(budget.period)) continue;
    const periode = periodStart(budget.period, now);
    terpakaiPerPeriode.set(
      budget.period,
      await ledger.spentPerCategory(deps.db, userId, periode.from, periode.to),
    );
  }

  for (const budget of budgets) {
    const terpakai = terpakaiPerPeriode.get(budget.period)?.get(budget.categoryId) ?? 0;
    const ratio = terpakai / budget.amount;
    if (ratio < BUDGET_WARN_RATIO) continue;

    const lewat = terpakai > budget.amount;
    const nama = categoryName.get(budget.categoryId) ?? 'Kategori';

    insights.push({
      id: `budget:${budget.id}`,
      kind: 'budget_risk',
      severity: lewat ? 'critical' : 'warning',
      title: lewat ? `Anggaran ${nama} terlampaui` : `Anggaran ${nama} hampir habis`,
      body: lewat
        ? `Sudah ${idr(terpakai)} dari batas ${idr(budget.amount)}.`
        : `${idr(terpakai)} dari ${idr(budget.amount)} terpakai. Sisa ${idr(budget.amount - terpakai)}.`,
      reason: `${String(Math.round(ratio * 100))}% batas periode berjalan.`,
      amount: terpakai,
      transactionId: null,
      categoryId: budget.categoryId,
    });
  }

  /* ── proyeksi arus kas ── */
  const window = daysBack(90, now);
  const flow = await ledger.cashflow(deps.db, userId, window.from, window.to, 'day');
  const saldo = [...balances.values()].reduce((sum, b) => sum + b, 0);

  const forecast = projectCashflow(saldo, flow);
  const runway = daysUntilEmpty(forecast);

  const projection: CashflowProjection = {
    startingBalance: forecast.startingBalance,
    dailyNet: forecast.dailyNet,
    points: forecast.points,
    basisDays: forecast.basisDays,
    reliable: forecast.reliable,
    daysUntilEmpty: runway,
  };

  if (runway !== null && runway <= RUNWAY_CRITICAL_DAYS) {
    insights.push({
      id: 'runway',
      kind: 'cashflow_risk',
      severity: runway <= 14 ? 'critical' : 'warning',
      title: 'Saldo menuju nol',
      body: `Dengan pola sekarang, saldomu habis dalam ${String(runway)} hari.`,
      reason: `Arus bersih ${idr(forecast.dailyNet)} per hari, dihitung dari ${String(forecast.basisDays)} hari terakhir.`,
      amount: saldo,
      transactionId: null,
      categoryId: null,
    });
  }

  /* Urutan tampil: yang paling mendesak lebih dulu. Wawasan yang benar tetapi
     terkubur di bawah lima wawasan informatif sama saja dengan tidak ada. */
  const rank = { critical: 0, warning: 1, info: 2 };
  insights.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return { generatedAt: now.getTime(), insights, projection, recurring };
}
