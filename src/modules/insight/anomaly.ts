/**
 * Deteksi anomali dan langganan hantu. ROADMAP M10.
 *
 * SELURUHNYA deterministik — tidak ada model, tidak ada panggilan jaringan.
 * Yang dipakai adalah statistik yang dapat dijelaskan kepada pengguna dalam
 * satu kalimat, dan itu bukan pembatasan melainkan syarat: peringatan keuangan
 * yang tidak dapat dijelaskan tidak akan dipercaya, dan yang tidak dipercaya
 * akan dimatikan.
 */

export interface AmountSample {
  id: string;
  categoryId: string | null;
  amount: number;
  occurredAt: number;
  merchant: string | null;
}

/* ── nominal janggal ─────────────────────────────────────────────────── */

export interface Anomaly {
  transactionId: string;
  amount: number;
  /** Rata-rata kategori yang sama, untuk pembanding di kalimat penjelas. */
  categoryMean: number;
  /** Berapa simpangan baku di atas rata-rata. */
  zScore: number;
}

/**
 * Berapa simpangan baku sebelum sebuah nominal disebut janggal.
 *
 * Tiga adalah ambang konvensional, dan pada distribusi normal ia menandai
 * sekitar 0,1% teratas. Lebih rendah menghasilkan peringatan setiap minggu
 * sampai pengguna berhenti membacanya — dan peringatan yang tidak dibaca sama
 * saja dengan tidak ada.
 */
const Z_THRESHOLD = 3;

/**
 * Jumlah minimum sampel sebelum sebuah kategori layak dinilai.
 *
 * Di bawah ini simpangan bakunya tidak bermakna: dua transaksi selalu
 * menghasilkan simpangan yang membuat salah satunya terlihat ekstrem.
 */
const MIN_SAMPLES = 8;

/**
 * Mencari nominal yang janggal terhadap kebiasaan kategorinya sendiri.
 *
 * Per KATEGORI, bukan terhadap seluruh transaksi. Sewa rumah lima juta bukan
 * anomali; kopi lima juta jelas anomali. Menilai keduanya terhadap rata-rata
 * yang sama akan melewatkan yang kedua dan menandai yang pertama.
 */
export function findAmountAnomalies(samples: readonly AmountSample[]): Anomaly[] {
  const byCategory = new Map<string, AmountSample[]>();

  for (const sample of samples) {
    /* Yang tanpa kategori dilewati: tidak ada kebiasaan untuk dibandingkan. */
    if (sample.categoryId === null) continue;
    byCategory.set(sample.categoryId, [...(byCategory.get(sample.categoryId) ?? []), sample]);
  }

  const anomalies: Anomaly[] = [];

  for (const group of byCategory.values()) {
    if (group.length < MIN_SAMPLES) continue;

    const amounts = group.map((s) => s.amount);
    const mean = amounts.reduce((sum, a) => sum + a, 0) / amounts.length;

    const variance =
      amounts.reduce((sum, a) => sum + (a - mean) ** 2, 0) / (amounts.length - 1);
    const sd = Math.sqrt(variance);

    /* Simpangan nol berarti seluruh nominalnya identik — tagihan tetap,
       misalnya. Tidak ada anomali yang mungkin, dan membaginya akan
       menghasilkan Infinity yang menandai semuanya. */
    if (sd === 0) continue;

    for (const sample of group) {
      const z = (sample.amount - mean) / sd;
      /* Hanya yang di ATAS rata-rata. Belanja yang luar biasa murah bukan
         masalah yang perlu diberitahukan kepada siapa pun. */
      if (z >= Z_THRESHOLD) {
        anomalies.push({
          transactionId: sample.id,
          amount: sample.amount,
          categoryMean: Math.round(mean),
          zScore: Math.round(z * 10) / 10,
        });
      }
    }
  }

  return anomalies.sort((a, b) => b.zScore - a.zScore);
}

/* ── langganan berulang ──────────────────────────────────────────────── */

export interface Subscription {
  merchant: string;
  /** Nominal khas — median, bukan rata-rata. */
  amount: number;
  /** Jarak khas antar tagihan, dalam hari. */
  intervalDays: number;
  occurrences: number;
  lastChargedAt: number;
  /**
   * Ditagih terus tetapi tidak tersentuh sejak lama.
   *
   * "Tidak tersentuh" di sini berarti nominalnya tidak berubah sama sekali dan
   * tidak ada transaksi lain di merchant yang sama — indikasi terbaik yang
   * dapat diperoleh tanpa data pemakaian aplikasi pihak ketiga.
   */
  dormant: boolean;
}

const DAY_MS = 86_400_000;

/** Berapa kali sebuah pola harus berulang sebelum disebut langganan. Tiga
 *  adalah minimum yang membedakan pola dari kebetulan. */
const MIN_OCCURRENCES = 3;

/** Toleransi jarak antar tagihan. Tanggal tagih bergeser karena akhir pekan dan
 *  hari libur; menuntut jarak persis akan melewatkan hampir semuanya. */
const INTERVAL_TOLERANCE_DAYS = 4;

/** Rentang jarak yang dianggap langganan: mingguan sampai tahunan. */
const MIN_INTERVAL_DAYS = 6;
const MAX_INTERVAL_DAYS = 400;

/** Sejak kapan sebuah langganan disebut tidur. Sembilan puluh hari adalah tiga
 *  siklus bulanan — cukup lama untuk bukan sekadar bulan yang terlewat. */
const DORMANT_AFTER_DAYS = 90;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0);
}

/**
 * Mencari tagihan berulang.
 *
 * Median dan bukan rata-rata untuk nominalnya: satu tagihan tahunan di antara
 * dua belas bulanan akan menarik rata-rata sampai tidak ada satu pun tagihan
 * yang mendekatinya.
 */
export function findSubscriptions(
  samples: readonly AmountSample[],
  now = Date.now(),
): Subscription[] {
  const byMerchant = new Map<string, AmountSample[]>();

  for (const sample of samples) {
    const merchant = sample.merchant?.trim().toLowerCase();
    if (!merchant) continue;
    byMerchant.set(merchant, [...(byMerchant.get(merchant) ?? []), sample]);
  }

  const subscriptions: Subscription[] = [];

  for (const [merchant, group] of byMerchant) {
    if (group.length < MIN_OCCURRENCES) continue;

    const ordered = [...group].sort((a, b) => a.occurredAt - b.occurredAt);

    const gaps: number[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      if (previous && current) gaps.push((current.occurredAt - previous.occurredAt) / DAY_MS);
    }

    const typical = median(gaps);
    if (typical < MIN_INTERVAL_DAYS || typical > MAX_INTERVAL_DAYS) continue;

    /* Seluruh jarak harus dekat dengan yang khas. Belanja di merchant yang
       sama tiga kali dalam sebulan bukan langganan — dan tanpa syarat ini,
       Indomaret akan muncul sebagai langganan bagi hampir semua orang. */
    const teratur = gaps.every((gap) => Math.abs(gap - typical) <= INTERVAL_TOLERANCE_DAYS);
    if (!teratur) continue;

    const amounts = ordered.map((s) => s.amount);
    const typicalAmount = median(amounts);

    /* Nominal juga harus stabil. Langganan menagih jumlah yang sama; yang
       berubah-ubah adalah belanja rutin, bukan langganan. */
    const stabil = amounts.every((a) => Math.abs(a - typicalAmount) <= typicalAmount * 0.05);
    if (!stabil) continue;

    const last = ordered.at(-1);
    if (!last) continue;

    subscriptions.push({
      /* Ditampilkan dengan huruf asli dari catatan terakhir, bukan yang sudah
         dikecilkan untuk pengelompokan. */
      merchant: last.merchant?.trim() ?? merchant,
      amount: typicalAmount,
      intervalDays: Math.round(typical),
      occurrences: ordered.length,
      lastChargedAt: last.occurredAt,
      dormant: now - last.occurredAt <= DORMANT_AFTER_DAYS * DAY_MS && ordered.length >= 4,
    });
  }

  return subscriptions.sort((a, b) => b.amount * (30 / b.intervalDays) - a.amount * (30 / a.intervalDays));
}

/** Biaya bulanan setara dari sebuah langganan, berapa pun siklusnya. */
export function monthlyCost(subscription: Subscription): number {
  return Math.round((subscription.amount * 30) / subscription.intervalDays);
}
