/**
 * Pengenal maksud pertanyaan. ROADMAP M13 — chat assistant grounded.
 *
 * DETERMINISTIK, dan itu keputusan pokoknya. Model bahasa tidak pernah
 * memutuskan apa yang ditanyakan pengguna maupun menghitung jawabannya; ia
 * hanya menyusun kalimat dari angka yang sudah dihitung server.
 *
 * Alasannya bukan kehati-hatian berlebih. Pertanyaan "berapa pengeluaranku
 * bulan ini" punya satu jawaban yang benar, dan jawaban itu ada di basis data.
 * Menyerahkannya kepada model berarti menyerahkan aritmetika kepada sesuatu
 * yang kadang salah menghitung — dan pada aplikasi uang, jawaban yang salah
 * dengan kalimat yang meyakinkan lebih berbahaya daripada tidak menjawab.
 *
 * "Grounded" berarti setiap jawaban membawa asal angkanya. Jawaban tanpa asal
 * tidak dapat diperiksa siapa pun, dan yang tidak dapat diperiksa akan
 * dipercaya atau diabaikan seluruhnya — keduanya buruk.
 */

export type QuestionIntent =
  /** Total pengeluaran pada suatu periode. */
  | 'spend_total'
  /** Total pemasukan pada suatu periode. */
  | 'income_total'
  /** Pengeluaran untuk satu kategori tertentu. */
  | 'spend_by_category'
  /** Ke mana uang paling banyak pergi. */
  | 'top_categories'
  /** Saldo seluruh dompet. */
  | 'balance'
  /** Transaksi terbesar pada suatu periode. */
  | 'largest_expense'
  /** Keadaan anggaran berjalan. */
  | 'budget_status'
  /** Tagihan berulang yang terdeteksi. */
  | 'subscriptions'
  /** Berapa lama saldo bertahan dengan pola sekarang. */
  | 'runway'
  /** Selisih pemasukan dan pengeluaran. */
  | 'net_flow';

export type Period = 'this_month' | 'last_month' | 'last_7_days' | 'last_30_days' | 'last_90_days';

export interface ResolvedQuestion {
  intent: QuestionIntent;
  period: Period;
  /** Kata kategori yang disebut penanya, bila ada. Dicocokkan pemanggil
   *  terhadap kategori pengguna sendiri. */
  categoryHint: string | null;
  /** Kata yang mencocokkan — supaya keputusannya dapat dijelaskan. */
  matched: string;
}

interface Rule {
  intent: QuestionIntent;
  keywords: readonly string[];
}

/**
 * Aturan maksud.
 *
 * Urutannya ADALAH prioritasnya. Yang lebih spesifik diperiksa lebih dulu:
 * "langganan" memuat kata yang juga muncul di pertanyaan pengeluaran umum, dan
 * "sisa" muncul baik di pertanyaan saldo maupun anggaran.
 */
const RULES: readonly Rule[] = [
  { intent: 'subscriptions', keywords: ['langganan', 'berlangganan', 'subscription', 'tagihan rutin', 'tagihan bulanan'] },
  { intent: 'runway', keywords: ['sampai kapan', 'bertahan', 'habis kapan', 'cukup sampai', 'runway', 'kehabisan'] },
  { intent: 'budget_status', keywords: ['anggaran', 'budget', 'batas belanja', 'jatah'] },
  { intent: 'largest_expense', keywords: ['terbesar', 'paling besar', 'paling mahal', 'terbanyak', 'boros'] },
  { intent: 'top_categories', keywords: ['ke mana', 'kemana', 'paling banyak untuk', 'habis untuk apa', 'untuk apa saja', 'rincian', 'breakdown'] },
  { intent: 'net_flow', keywords: ['selisih', 'sisa bulanan', 'nabung berapa', 'menabung berapa', 'surplus', 'defisit'] },
  { intent: 'balance', keywords: ['saldo', 'uangku berapa', 'punya berapa', 'kekayaan', 'total dompet'] },
  { intent: 'income_total', keywords: ['pemasukan', 'pendapatan', 'masuk berapa', 'gaji', 'penghasilan'] },
  { intent: 'spend_by_category', keywords: ['untuk', 'buat', 'kategori'] },
  { intent: 'spend_total', keywords: ['pengeluaran', 'keluar berapa', 'habis berapa', 'belanja', 'menghabiskan', 'spending'] },
];

const PERIOD_RULES: readonly { period: Period; keywords: readonly string[] }[] = [
  { period: 'last_month', keywords: ['bulan lalu', 'bulan kemarin', 'bulan sebelumnya'] },
  { period: 'last_7_days', keywords: ['minggu ini', 'seminggu', '7 hari', 'tujuh hari', 'pekan ini'] },
  { period: 'last_90_days', keywords: ['3 bulan', 'tiga bulan', '90 hari', 'kuartal'] },
  { period: 'last_30_days', keywords: ['30 hari', 'tiga puluh hari', 'sebulan terakhir'] },
  { period: 'this_month', keywords: ['bulan ini', 'sekarang', 'saat ini'] },
];

/**
 * Kata yang menyusul "untuk" atau "buat" pada pertanyaan kategori.
 *
 * Diambil sampai akhir kalimat atau sampai penanda periode — "berapa untuk
 * makan bulan ini" harus menghasilkan "makan", bukan "makan bulan ini".
 */
const PERIOD_WORDS = /\b(bulan|minggu|pekan|hari|kuartal|tahun|sekarang|kemarin|lalu|ini|terakhir)\b/;

function extractCategoryHint(question: string): string | null {
  const match = /\b(?:untuk|buat|di|pada)\s+(.+)$/i.exec(question);
  if (!match?.[1]) return null;

  const words: string[] = [];
  for (const word of match[1].split(/\s+/)) {
    /* Berhenti pada kata periode: sisanya menerangkan waktu, bukan kategori. */
    if (PERIOD_WORDS.test(word.toLowerCase())) break;
    words.push(word);
  }

  const hint = words.join(' ').replace(/[?.!,]+$/, '').trim();
  return hint.length >= 3 ? hint : null;
}

/**
 * Mengenali maksud pertanyaan.
 *
 * Mengembalikan `null` bila tidak ada yang cocok, dan itulah jawaban yang
 * benar. Menebak maksud akan menghasilkan angka yang benar untuk pertanyaan
 * yang salah — dan pengguna yang menerima jawaban meyakinkan atas pertanyaan
 * lain tidak punya cara mengetahuinya.
 */
export function resolveQuestion(question: string): ResolvedQuestion | null {
  const text = question.toLowerCase().trim();
  if (text.length < 3) return null;

  let intent: QuestionIntent | null = null;
  let matched = '';

  for (const rule of RULES) {
    const hit = rule.keywords.find((keyword) => text.includes(keyword));
    if (hit) {
      intent = rule.intent;
      matched = hit;
      break;
    }
  }

  if (intent === null) return null;

  const categoryHint = extractCategoryHint(text);

  /*
   * "untuk" dan "buat" adalah penanda paling lemah — keduanya muncul di hampir
   * setiap kalimat. Bila keduanya yang mencocokkan tetapi tidak ada kategori
   * yang tersisa sesudahnya, pertanyaannya bukan tentang kategori.
   */
  if (intent === 'spend_by_category' && categoryHint === null) return null;

  let period: Period = 'this_month';
  for (const rule of PERIOD_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      period = rule.period;
      break;
    }
  }

  return { intent, period, categoryHint, matched };
}

/** Label periode untuk kalimat jawaban. */
export const PERIOD_LABEL: Record<Period, string> = {
  this_month: 'bulan ini',
  last_month: 'bulan lalu',
  last_7_days: 'tujuh hari terakhir',
  last_30_days: 'tiga puluh hari terakhir',
  last_90_days: 'sembilan puluh hari terakhir',
};
