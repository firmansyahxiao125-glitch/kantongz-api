import { dompetTerlihat } from '../ledger/akses-dompet.js';
import type { InsightDigest } from '../../contracts/insight.js';
import { DomainError } from '../../contracts/domain.js';
import type { Database } from '../../platform/db/client.js';
import * as insight from '../insight/service.js';
import { daysBack, monthRange } from '../ledger/periods.js';
import * as ledger from '../ledger/repository.js';
import type { LanguageModel } from './provider.js';

/**
 * Asisten. ROADMAP M11 (ringkasan proaktif) dan M13 (simulasi what-if).
 *
 * DUA LAPISAN, dan pemisahannya adalah keputusan pokok berkas ini.
 *
 * Lapisan pertama menghitung. Ia deterministik, berjalan tanpa kredensial apa
 * pun, dan angkanya adalah angka sungguhan dari basis data. Simulasi what-if
 * seluruhnya hidup di sini — pertanyaan "kalau saya cicil 1,2 juta per bulan,
 * aman tidak?" adalah aritmetika, dan menyerahkannya ke model berarti menyerahkan
 * aritmetika kepada sesuatu yang kadang salah menghitung.
 *
 * Lapisan kedua MENARASIKAN angka yang sudah dihitung. Hanya itu. Ia menerima
 * ringkasan agregat — tanpa nama, tanpa merchant, tanpa id — dan mengembalikan
 * kalimat. Bila kredensialnya tidak ada, narasinya disusun templat, dan
 * pengguna diberi tahu bahwa ringkasannya disusun tanpa model.
 */

export interface AssistantDeps {
  db: Database;
  model: LanguageModel;
}

const IDR = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
});

function idr(value: number): string {
  return IDR.format(value);
}

/* ── M13: simulasi what-if ───────────────────────────────────────────── */

export interface SimulationInput {
  /** Komitmen bulanan baru yang sedang dipertimbangkan. */
  monthlyCommitment: number;
  /** Berapa bulan komitmen itu berjalan. */
  months: number;
}

export type SimulationVerdict = 'aman' | 'ketat' | 'tidak_aman';

export interface Simulation {
  monthlyCommitment: number;
  months: number;
  /** Sisa bulanan sekarang, sebelum komitmen. */
  currentMonthlySurplus: number;
  /** Sisa bulanan setelah komitmen. Negatif berarti defisit. */
  projectedMonthlySurplus: number;
  /** Saldo perkiraan di akhir periode komitmen. */
  balanceAtEnd: number;
  /** Berapa bulan sampai saldo habis, bila memang menuju ke sana. */
  monthsUntilEmpty: number | null;
  verdict: SimulationVerdict;
  /** Angka yang mendasari putusan, dalam satu kalimat. */
  reason: string;
  /** Berapa hari data yang dipakai. */
  basisDays: number;
  reliable: boolean;
}

/** Sisa bulanan di bawah ini disebut ketat: satu kejadian tak terduga
 *  menghabiskannya. Sepuluh persen dari komitmen adalah bantalan minimum yang
 *  masih bermakna. */
const TIGHT_MARGIN_RATIO = 0.1;

const DAYS_PER_MONTH = 30;

/**
 * Menjawab "kalau saya ambil komitmen ini, aman tidak?" dengan aritmetika.
 *
 * Seluruhnya dari data pengguna sendiri — pemasukan dan pengeluaran sembilan
 * puluh hari terakhir. Tidak ada model yang terlibat, dan itulah sebabnya
 * jawabannya dapat diperiksa ulang oleh siapa pun dengan kalkulator.
 */
export async function simulate(
  deps: AssistantDeps,
  userId: string,
  input: SimulationInput,
  now = new Date(),
): Promise<Simulation> {
  if (!Number.isSafeInteger(input.monthlyCommitment) || input.monthlyCommitment <= 0) {
    throw new DomainError('invalid_input', 'komitmen bulanan harus lebih dari nol');
  }
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > 360) {
    throw new DomainError('invalid_input', 'jangka waktu harus 1 sampai 360 bulan');
  }

  const window = daysBack(90, now);

  const [flow, balances] = await Promise.all([
    ledger.cashflow(deps.db, userId, window.from, window.to, 'day'),
    ledger.balances(deps.db, userId, await dompetTerlihat(deps.db, userId)),
  ]);

  const saldo = [...balances.values()].reduce((sum, b) => sum + b, 0);
  const basisDays = flow.length;

  /* Di bawah dua siklus penggajian, "sisa bulanan" belum menggambarkan apa
     pun — satu gaji yang jatuh di dalam atau di luar jendela mengubah seluruh
     jawabannya. */
  const reliable = basisDays >= 60;

  const totalIncome = flow.reduce((sum, d) => sum + d.income, 0);
  const totalExpense = flow.reduce((sum, d) => sum + d.expense, 0);

  const surplusPerDay = basisDays === 0 ? 0 : (totalIncome - totalExpense) / basisDays;
  const currentMonthlySurplus = Math.round(surplusPerDay * DAYS_PER_MONTH);
  const projectedMonthlySurplus = currentMonthlySurplus - input.monthlyCommitment;

  const balanceAtEnd = Math.round(saldo + projectedMonthlySurplus * input.months);

  const monthsUntilEmpty =
    projectedMonthlySurplus >= 0
      ? null
      : Math.max(0, Math.floor(saldo / -projectedMonthlySurplus));

  const verdict: SimulationVerdict =
    projectedMonthlySurplus < 0
      ? 'tidak_aman'
      : projectedMonthlySurplus < input.monthlyCommitment * TIGHT_MARGIN_RATIO
        ? 'ketat'
        : 'aman';

  const reason =
    verdict === 'tidak_aman'
      ? `Sisa bulananmu ${idr(currentMonthlySurplus)}, dan komitmen ${idr(input.monthlyCommitment)} melampauinya. Kekurangannya ${idr(-projectedMonthlySurplus)} setiap bulan.`
      : verdict === 'ketat'
        ? `Setelah komitmen, sisa bulananmu tinggal ${idr(projectedMonthlySurplus)}. Satu kejadian tak terduga menghabiskannya.`
        : `Setelah komitmen, sisa bulananmu ${idr(projectedMonthlySurplus)} — masih ada ruang.`;

  return {
    monthlyCommitment: input.monthlyCommitment,
    months: input.months,
    currentMonthlySurplus,
    projectedMonthlySurplus,
    balanceAtEnd,
    monthsUntilEmpty,
    verdict,
    reason,
    basisDays,
    reliable,
  };
}

/* ── M11: ringkasan periode ──────────────────────────────────────────── */

export interface PeriodSummary {
  /** Awal dan akhir periode, epoch milidetik. */
  from: number;
  to: number;
  income: number;
  expense: number;
  net: number;
  /** Tiga kategori pengeluaran teratas. */
  topCategories: { name: string; total: number }[];
  /** Kalimat ringkasan. */
  narrative: string;
  /**
   * Apakah narasinya disusun model atau templat.
   *
   * Dinyatakan terbuka kepada pengguna. Ringkasan bertemplat yang menyamar
   * sebagai analisis adalah kebohongan kecil yang merusak kepercayaan pada
   * seluruh angka di sekitarnya.
   */
  narrativeSource: 'model' | 'template';
  insights: InsightDigest['insights'];
}

/** Instruksi peran. Tetap, tidak pernah memuat data pengguna. */
const SYSTEM_PROMPT = [
  'Kamu menulis ringkasan keuangan pribadi berbahasa Indonesia untuk aplikasi KANTONGZ.',
  'Tulis 2–3 kalimat, langsung ke inti, tanpa sapaan dan tanpa basa-basi.',
  'Pakai HANYA angka yang diberikan. Jangan mengarang angka, tren, atau nama apa pun.',
  'Jangan memberi nasihat investasi. Boleh menunjuk pola dan menyarankan tindakan sederhana.',
  'Jangan memakai tanda bintang, markdown, atau daftar berbutir.',
].join(' ');

/**
 * Ringkasan periode, dengan narasi dari model bila tersedia.
 *
 * Angkanya dihitung server dan TIDAK PERNAH datang dari model. Model hanya
 * menyusun kalimatnya — dan bila ia gagal, angkanya tetap benar dan templat
 * mengambil alih. Ringkasan yang gagal seluruhnya karena penyedia model sedang
 * jatuh adalah kegagalan yang tidak perlu ditanggung pengguna.
 */
export async function summarise(
  deps: AssistantDeps,
  userId: string,
  now = new Date(),
): Promise<PeriodSummary> {
  const range = monthRange(now);

  const [totals, breakdown, digest] = await Promise.all([
    ledger.totalsBetween(deps.db, userId, range.from, range.to),
    ledger.expenseByCategory(deps.db, userId, range.from, range.to, 3),
    insight.digest({ db: deps.db }, userId, now),
  ]);

  const topCategories = breakdown.map((row) => ({
    name: row.categoryName ?? 'Tanpa kategori',
    total: row.total,
  }));

  const net = totals.income - totals.expense;

  const facts = [
    `Pemasukan bulan ini: ${idr(totals.income)}.`,
    `Pengeluaran bulan ini: ${idr(totals.expense)}.`,
    `Selisih: ${idr(net)}.`,
    topCategories.length > 0
      ? `Pengeluaran terbesar: ${topCategories.map((c) => `${c.name} ${idr(c.total)}`).join(', ')}.`
      : 'Belum ada pengeluaran berkategori.',
    ...digest.insights.slice(0, 3).map((i) => `${i.title}: ${i.body}`),
  ].join('\n');

  const template = templateNarrative(totals.income, totals.expense, net, topCategories);

  /*
   * Jalur templat dipakai ketika kredensialnya tidak ada MAUPUN ketika
   * penyedianya gagal. Keduanya menghasilkan ringkasan yang sama-sama benar
   * angkanya; yang berbeda hanya kalimatnya.
   */
  if (!deps.model.available) {
    return {
      from: range.from.getTime(),
      to: range.to.getTime(),
      income: totals.income,
      expense: totals.expense,
      net,
      topCategories,
      narrative: template,
      narrativeSource: 'template',
      insights: digest.insights,
    };
  }

  let narrative = template;
  let source: PeriodSummary['narrativeSource'] = 'template';

  try {
    narrative = await deps.model.complete({
      system: SYSTEM_PROMPT,
      /* HANYA angka agregat. Tidak ada nama, email, merchant, maupun id — UU
         PDP memperlakukan riwayat transaksi sebagai data pribadi, dan penyedia
         model adalah pihak ketiga. */
      prompt: facts,
      maxTokens: 300,
    });
    source = 'model';
  } catch {
    /* Angkanya tetap benar. Yang hilang hanya kalimatnya. */
  }

  return {
    from: range.from.getTime(),
    to: range.to.getTime(),
    income: totals.income,
    expense: totals.expense,
    net,
    topCategories,
    narrative,
    narrativeSource: source,
    insights: digest.insights,
  };
}

/**
 * Narasi tanpa model.
 *
 * Bukan penampung sementara: inilah yang dibaca pengguna ketika penyedia model
 * sedang jatuh, dan ia harus tetap berguna. Kalimatnya menyebut angka yang sama
 * dan menunjuk hal yang sama.
 */
function templateNarrative(
  income: number,
  expense: number,
  net: number,
  top: { name: string; total: number }[],
): string {
  if (income === 0 && expense === 0) {
    return 'Belum ada transaksi bulan ini. Catat pemasukan dan pengeluaranmu supaya ringkasan berikutnya punya isi.';
  }

  const arah =
    net > 0
      ? `Bulan ini kamu menyisakan ${idr(net)}.`
      : net < 0
        ? `Bulan ini pengeluaranmu melebihi pemasukan sebesar ${idr(-net)}.`
        : 'Bulan ini pemasukan dan pengeluaranmu seimbang.';

  const terbesar = top[0];
  const sorotan = terbesar
    ? ` Pengeluaran terbesarmu ${terbesar.name} sebesar ${idr(terbesar.total)}.`
    : '';

  return `${arah}${sorotan} Total masuk ${idr(income)}, keluar ${idr(expense)}.`;
}
