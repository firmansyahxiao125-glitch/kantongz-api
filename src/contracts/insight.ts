/**
 * Kontrak lapisan wawasan. ROADMAP M9–M12.
 *
 * SETIAP wawasan wajib membawa penjelasannya sendiri. Bukan kesopanan: saran
 * keuangan yang tidak dapat dijelaskan tidak akan dipercaya, dan yang tidak
 * dipercaya akan dimatikan bersama seluruh notifikasi lainnya.
 */

export type InsightKind =
  /** Nominal janggal terhadap kebiasaan kategorinya sendiri. M10 */
  | 'anomaly'
  /** Tagihan berulang yang tampak tidak terpakai. M10 */
  | 'ghost_subscription'
  /** Anggaran yang hampir atau sudah terlampaui. M8 */
  | 'budget_risk'
  /** Saldo diproyeksikan menyentuh nol. M12 */
  | 'cashflow_risk'
  /** Ringkasan naratif periode. M11 */
  | 'weekly_summary';

export type InsightSeverity = 'info' | 'warning' | 'critical';

export interface Insight {
  id: string;
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  /** Satu kalimat yang boleh ditampilkan apa adanya. */
  body: string;
  /**
   * MENGAPA wawasan ini muncul, dalam angka.
   *
   * Ditampilkan saat pengguna menekan "kenapa?". Wawasan tanpa ini adalah
   * tebakan yang menyamar sebagai analisis.
   */
  reason: string;
  /** Nilai rupiah yang menjadi pokok wawasan, bila ada. */
  amount: number | null;
  /** Sumber data yang dapat dibuka pengguna. */
  transactionId: string | null;
  categoryId: string | null;
}

export interface CashflowProjectionPoint {
  horizonDays: number;
  expected: number;
  low: number;
  high: number;
}

export interface CashflowProjection {
  startingBalance: number;
  dailyNet: number;
  points: CashflowProjectionPoint[];
  basisDays: number;
  /** `false` berarti datanya belum cukup — bukan proyeksi dengan pita selebar
   *  samudra yang tetap ditampilkan seolah bermakna. */
  reliable: boolean;
  /** Hari perkiraan saldo menyentuh nol. `null` berarti tidak sedang ke sana. */
  daysUntilEmpty: number | null;
}

export interface RecurringCharge {
  merchant: string;
  amount: number;
  intervalDays: number;
  occurrences: number;
  lastChargedAt: number;
  monthlyCost: number;
  dormant: boolean;
}

export interface InsightDigest {
  generatedAt: number;
  insights: Insight[];
  projection: CashflowProjection;
  recurring: RecurringCharge[];
}

/** Usulan kategori untuk transaksi tanpa kategori. M9 */
export interface CategorySuggestion {
  transactionId: string;
  categoryId: string;
  categoryName: string;
  /** Kata kunci yang mencocokkan — supaya keputusannya dapat dijelaskan. */
  reason: string;
}
