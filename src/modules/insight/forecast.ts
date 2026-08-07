/**
 * Proyeksi arus kas. ROADMAP M12.
 *
 * Dengan PITA KETIDAKPASTIAN, bukan angka tunggal. Angka tunggal pada proyeksi
 * keuangan adalah kebohongan yang rapi: ia terlihat tepat, tidak pernah tepat,
 * dan pengguna yang mempercayainya mengambil keputusan berdasarkan presisi yang
 * tidak pernah ada.
 *
 * Metodenya sengaja sederhana dan dapat dijelaskan: rata-rata bergerak atas
 * arus bersih harian, dengan pita dari simpangan bakunya. Model yang lebih
 * canggih akan menghasilkan angka yang lebih halus dan penjelasan yang lebih
 * sulit — dan pada peringatan keuangan, yang tidak dapat dijelaskan tidak akan
 * dipercaya.
 */

export interface DailyFlow {
  /** `YYYY-MM-DD`. */
  bucket: string;
  income: number;
  expense: number;
}

export interface ForecastPoint {
  /** Hari ke depan dari sekarang: 30, 60, 90. */
  horizonDays: number;
  /** Proyeksi saldo pada hari itu. */
  expected: number;
  /** Batas bawah dan atas pita. */
  low: number;
  high: number;
}

export interface Forecast {
  /** Saldo saat proyeksi dibuat. */
  startingBalance: number;
  /** Arus bersih harian rata-rata yang mendasari proyeksi. */
  dailyNet: number;
  points: ForecastPoint[];
  /**
   * Berapa hari data yang dipakai.
   *
   * Ditampilkan kepada pengguna. Proyeksi dari sepuluh hari data dan dari
   * setahun data terlihat sama di layar, dan yang pertama tidak layak dipercaya
   * dengan cara yang sama.
   */
  basisDays: number;
  /**
   * `false` bila datanya terlalu sedikit untuk proyeksi yang bermakna.
   *
   * Bukan `null` yang harus ditebak pemanggil, dan bukan proyeksi yang tetap
   * diberikan dengan pita selebar samudra.
   */
  reliable: boolean;
}

/** Di bawah ini proyeksi tidak bermakna: variasi harian belum terbentuk. */
const MIN_BASIS_DAYS = 14;

/** Cakupan pita. 1,28 simpangan baku menandai sekitar 80% — dipilih di atas
 *  95% karena pita 95% pada data harian begitu lebar sampai tidak memberi
 *  informasi apa pun. */
const BAND_Z = 1.28;

/**
 * Memproyeksikan saldo untuk 30, 60, dan 90 hari.
 *
 * Ketidakpastian tumbuh dengan AKAR jumlah hari, bukan linear. Itu bukan
 * pilihan gaya: arus harian yang saling bebas menjumlahkan variansinya, dan
 * simpangan bakunya karena itu tumbuh sebagai √n. Pita linear akan terlalu
 * lebar di hari ke-90 dan terlalu sempit di hari ke-30.
 */
export function projectCashflow(
  startingBalance: number,
  history: readonly DailyFlow[],
  horizons: readonly number[] = [30, 60, 90],
): Forecast {
  const nets = history.map((day) => day.income - day.expense);
  const basisDays = nets.length;

  if (basisDays < MIN_BASIS_DAYS) {
    return {
      startingBalance,
      dailyNet: 0,
      points: [],
      basisDays,
      reliable: false,
    };
  }

  const mean = nets.reduce((sum, n) => sum + n, 0) / basisDays;
  const variance = nets.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (basisDays - 1);
  const sd = Math.sqrt(variance);

  const points = horizons.map((days) => {
    const drift = mean * days;
    const spread = BAND_Z * sd * Math.sqrt(days);

    return {
      horizonDays: days,
      expected: Math.round(startingBalance + drift),
      low: Math.round(startingBalance + drift - spread),
      high: Math.round(startingBalance + drift + spread),
    };
  });

  return {
    startingBalance,
    dailyNet: Math.round(mean),
    points,
    basisDays,
    reliable: true,
  };
}

/**
 * Hari perkiraan saldo menyentuh nol, bila arahnya memang ke sana.
 *
 * `null` berarti saldo tidak sedang menuju nol — dan itu jawaban yang benar,
 * bukan angka besar yang menyiratkan tanggal jatuh tempo yang jauh.
 */
export function daysUntilEmpty(forecast: Forecast): number | null {
  if (!forecast.reliable || forecast.dailyNet >= 0) return null;
  if (forecast.startingBalance <= 0) return 0;

  return Math.floor(forecast.startingBalance / -forecast.dailyNet);
}
