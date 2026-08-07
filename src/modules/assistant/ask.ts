import type { Database } from '../../platform/db/client.js';
import { DomainError } from '../../contracts/domain.js';
import { findSubscriptions, monthlyCost } from '../insight/anomaly.js';
import { daysUntilEmpty, projectCashflow } from '../insight/forecast.js';
import { daysBack, monthRange, previousMonthRange, type Range } from '../ledger/periods.js';
import * as ledger from '../ledger/repository.js';
import { PERIOD_LABEL, resolveQuestion, type Period, type ResolvedQuestion } from './intent.js';

/**
 * Menjawab pertanyaan tentang data pengguna sendiri. ROADMAP M13.
 *
 * SELURUH angka dihitung di sini, dari basis data. Model bahasa — bila ada —
 * hanya menyusun kalimatnya dari angka yang sudah jadi, dan berkas ini tidak
 * mengenal model sama sekali.
 *
 * Setiap jawaban membawa `grounding`: dari mana angkanya, periode mana, dan
 * berapa baris yang dihitung. Jawaban tanpa asal tidak dapat diperiksa siapa
 * pun, dan yang tidak dapat diperiksa akan dipercaya bulat-bulat atau diabaikan
 * seluruhnya — keduanya buruk pada aplikasi uang.
 */

export interface AskDeps {
  db: Database;
}

export interface Answer {
  /** Pertanyaan sebagaimana diterima, untuk ditampilkan kembali. */
  question: string;
  /** `null` bila maksudnya tidak dikenali. */
  intent: ResolvedQuestion['intent'] | null;
  /** Jawaban dalam kalimat, sudah memuat angkanya. Boleh ditampilkan apa adanya. */
  answer: string;
  /**
   * Dari mana angkanya. Ditampilkan di bawah jawaban.
   *
   * Bukan hiasan: inilah yang membedakan jawaban yang dapat diperiksa dari
   * kalimat yang terdengar meyakinkan.
   */
  grounding: string | null;
  /** Nilai pokok jawaban, bila ada satu. */
  amount: number | null;
}

const IDR = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
});

function idr(value: number): string {
  return IDR.format(value);
}

function rangeFor(period: Period, now: Date): Range {
  switch (period) {
    case 'last_month':
      return previousMonthRange(now);
    case 'last_7_days':
      return daysBack(7, now);
    case 'last_30_days':
      return daysBack(30, now);
    case 'last_90_days':
      return daysBack(90, now);
    case 'this_month':
    default:
      return monthRange(now);
  }
}

/**
 * Kalimat yang diberikan ketika maksudnya tidak dikenali.
 *
 * Menyebutkan apa yang BISA ditanyakan, bukan sekadar menolak. Penolakan tanpa
 * arah membuat pengguna menyerah pada percobaan kedua.
 */
const TIDAK_DIKENALI = [
  'Aku belum bisa menjawab itu. Yang bisa kutanyakan ke datamu:',
  'pengeluaran atau pemasukan pada suatu periode,',
  'rincian per kategori, transaksi terbesar, saldo,',
  'keadaan anggaran, langganan berulang, dan berapa lama saldomu bertahan.',
].join(' ');

export async function ask(
  deps: AskDeps,
  userId: string,
  question: string,
  now = new Date(),
): Promise<Answer> {
  const trimmed = question.trim();
  if (trimmed.length === 0) throw new DomainError('invalid_input', 'pertanyaan kosong');

  const resolved = resolveQuestion(trimmed);

  if (!resolved) {
    return { question: trimmed, intent: null, answer: TIDAK_DIKENALI, grounding: null, amount: null };
  }

  const range = rangeFor(resolved.period, now);
  const label = PERIOD_LABEL[resolved.period];

  switch (resolved.intent) {
    case 'spend_total':
    case 'income_total': {
      const totals = await ledger.totalsBetween(deps.db, userId, range.from, range.to);
      const masuk = resolved.intent === 'income_total';
      const amount = masuk ? totals.income : totals.expense;

      return {
        question: trimmed,
        intent: resolved.intent,
        answer: `${masuk ? 'Pemasukanmu' : 'Pengeluaranmu'} ${label} ${idr(amount)}.`,
        grounding: `Dijumlahkan dari transaksi ${masuk ? 'pemasukan' : 'pengeluaran'} ${label}. Transfer antar dompet tidak dihitung.`,
        amount,
      };
    }

    case 'net_flow': {
      const totals = await ledger.totalsBetween(deps.db, userId, range.from, range.to);
      const net = totals.income - totals.expense;

      return {
        question: trimmed,
        intent: resolved.intent,
        answer:
          net > 0
            ? `${label.charAt(0).toUpperCase()}${label.slice(1)} kamu menyisakan ${idr(net)}.`
            : net < 0
              ? `${label.charAt(0).toUpperCase()}${label.slice(1)} pengeluaranmu melebihi pemasukan sebesar ${idr(-net)}.`
              : `${label.charAt(0).toUpperCase()}${label.slice(1)} pemasukan dan pengeluaranmu seimbang.`,
        grounding: `Masuk ${idr(totals.income)}, keluar ${idr(totals.expense)}, ${label}.`,
        amount: net,
      };
    }

    case 'spend_by_category': {
      const breakdown = await ledger.expenseByCategory(deps.db, userId, range.from, range.to, 50);
      const hint = (resolved.categoryHint ?? '').toLowerCase();

      const match = breakdown.find((row) =>
        (row.categoryName ?? '').toLowerCase().includes(hint),
      );

      if (!match) {
        return {
          question: trimmed,
          intent: resolved.intent,
          answer: `Tidak ada pengeluaran untuk "${resolved.categoryHint ?? ''}" ${label}.`,
          grounding: `Dicari di antara ${String(breakdown.length)} kategori yang punya pengeluaran ${label}.`,
          amount: 0,
        };
      }

      return {
        question: trimmed,
        intent: resolved.intent,
        answer: `Kamu menghabiskan ${idr(match.total)} untuk ${match.categoryName ?? 'kategori itu'} ${label}.`,
        grounding: `Dijumlahkan dari transaksi berkategori ${match.categoryName ?? '—'} ${label}.`,
        amount: match.total,
      };
    }

    case 'top_categories': {
      const breakdown = await ledger.expenseByCategory(deps.db, userId, range.from, range.to, 3);

      if (breakdown.length === 0) {
        return {
          question: trimmed,
          intent: resolved.intent,
          answer: `Belum ada pengeluaran berkategori ${label}.`,
          grounding: null,
          amount: 0,
        };
      }

      const daftar = breakdown
        .map((row) => `${row.categoryName ?? 'Tanpa kategori'} ${idr(row.total)}`)
        .join(', ');

      return {
        question: trimmed,
        intent: resolved.intent,
        answer: `Uangmu paling banyak pergi ke: ${daftar}.`,
        grounding: `Tiga kategori teratas ${label}, diurutkan menurut total.`,
        amount: breakdown[0]?.total ?? null,
      };
    }

    case 'largest_expense': {
      const page = await ledger.listTransactions(deps.db, userId, {
        kind: 'expense',
        from: range.from,
        to: range.to,
        limit: 100,
      });

      /* Diurutkan di sini dan bukan di SQL: daftar seratus baris sudah ada di
         memori untuk keperluan ini saja, dan indeks yang ada mengurutkan
         menurut waktu, bukan nominal. */
      const largest = [...page].sort((a, b) => b.amount - a.amount)[0];

      if (!largest) {
        return {
          question: trimmed,
          intent: resolved.intent,
          answer: `Belum ada pengeluaran ${label}.`,
          grounding: null,
          amount: null,
        };
      }

      const nama = largest.merchant ?? largest.note ?? 'transaksi tanpa keterangan';

      return {
        question: trimmed,
        intent: resolved.intent,
        answer: `Pengeluaran terbesarmu ${label} adalah ${idr(largest.amount)} untuk ${nama}.`,
        grounding: `Dari ${String(page.length)} transaksi pengeluaran ${label}.`,
        amount: largest.amount,
      };
    }

    case 'balance': {
      const balances = await ledger.balances(deps.db, userId);
      const total = [...balances.values()].reduce((sum, b) => sum + b, 0);

      return {
        question: trimmed,
        intent: resolved.intent,
        answer: `Saldomu di seluruh dompet ${idr(total)}.`,
        grounding: `Dihitung dari saldo awal ${String(balances.size)} dompet ditambah seluruh transaksi.`,
        amount: total,
      };
    }

    case 'budget_status': {
      const budgets = await ledger.listBudgets(deps.db, userId);

      if (budgets.length === 0) {
        return {
          question: trimmed,
          intent: resolved.intent,
          answer: 'Kamu belum punya anggaran. Tetapkan batas untuk kategori yang paling sering menguras.',
          grounding: null,
          amount: null,
        };
      }

      const bulan = monthRange(now);
      const spent = await ledger.spentPerCategory(deps.db, userId, bulan.from, bulan.to);

      const lewat = budgets.filter((b) => (spent.get(b.categoryId) ?? 0) > b.amount);
      const totalBatas = budgets.reduce((sum, b) => sum + b.amount, 0);
      const totalPakai = budgets.reduce((sum, b) => sum + (spent.get(b.categoryId) ?? 0), 0);

      return {
        question: trimmed,
        intent: resolved.intent,
        answer:
          lewat.length > 0
            ? `${String(lewat.length)} dari ${String(budgets.length)} anggaranmu sudah terlampaui. Total terpakai ${idr(totalPakai)} dari ${idr(totalBatas)}.`
            : `Seluruh ${String(budgets.length)} anggaranmu masih aman. Terpakai ${idr(totalPakai)} dari ${idr(totalBatas)}.`,
        grounding: 'Dihitung dari pengeluaran periode berjalan per kategori.',
        amount: totalPakai,
      };
    }

    case 'subscriptions': {
      const window = daysBack(180, now);
      const rows = await ledger.listTransactions(deps.db, userId, {
        kind: 'expense',
        from: window.from,
        to: window.to,
        limit: 100,
      });

      const subs = findSubscriptions(
        rows.map((row) => ({
          id: row.id,
          categoryId: row.categoryId,
          amount: row.amount,
          occurredAt: row.occurredAt.getTime(),
          merchant: row.merchant,
        })),
        now.getTime(),
      );

      if (subs.length === 0) {
        return {
          question: trimmed,
          intent: resolved.intent,
          answer: 'Aku belum menemukan tagihan berulang di enam bulan terakhir.',
          grounding: `Dicari pola berjarak tetap dengan nominal tetap di antara ${String(rows.length)} transaksi.`,
          amount: 0,
        };
      }

      const total = subs.reduce((sum, s) => sum + monthlyCost(s), 0);
      const daftar = subs.slice(0, 3).map((s) => `${s.merchant} ${idr(monthlyCost(s))}`).join(', ');

      return {
        question: trimmed,
        intent: resolved.intent,
        answer: `Ada ${String(subs.length)} tagihan berulang, total ${idr(total)} per bulan: ${daftar}.`,
        grounding: `Pola berjarak tetap dengan nominal yang tidak berubah, dari enam bulan terakhir.`,
        amount: total,
      };
    }

    case 'runway': {
      const window = daysBack(90, now);
      const [flow, balances] = await Promise.all([
        ledger.cashflow(deps.db, userId, window.from, window.to, 'day'),
        ledger.balances(deps.db, userId),
      ]);

      const saldo = [...balances.values()].reduce((sum, b) => sum + b, 0);
      const forecast = projectCashflow(saldo, flow);
      const sisa = daysUntilEmpty(forecast);

      if (!forecast.reliable) {
        return {
          question: trimmed,
          intent: resolved.intent,
          answer: `Datanya belum cukup untuk menjawab itu — baru ${String(forecast.basisDays)} hari tercatat.`,
          grounding: 'Proyeksi menuntut sekurang-kurangnya empat belas hari riwayat.',
          amount: saldo,
        };
      }

      return {
        question: trimmed,
        intent: resolved.intent,
        answer:
          sisa === null
            ? `Saldomu tidak sedang menuju nol — arus bersihmu ${idr(forecast.dailyNet)} per hari.`
            : `Dengan pola sekarang, saldomu habis dalam ${String(sisa)} hari.`,
        grounding: `Arus bersih ${idr(forecast.dailyNet)} per hari, dihitung dari ${String(forecast.basisDays)} hari terakhir.`,
        amount: saldo,
      };
    }
  }
}
