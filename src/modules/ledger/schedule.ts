/**
 * Aritmetika kalender untuk aturan berulang.
 *
 * SELURUH berkas ini bekerja pada `YYYY-MM-DD` — tanggal kalender, bukan
 * titik waktu. Itu disengaja: "tanggal 1 setiap bulan" adalah pernyataan
 * tentang kalender, dan mengerjakannya dengan cap waktu berarti menambahkan
 * zona waktu ke perhitungan yang tidak membutuhkannya. Perubahan ke titik
 * waktu terjadi SEKALI, di `localNoon`, saat transaksinya benar-benar ditulis.
 *
 * Tidak ada satu pun fungsi di sini yang membaca jam sistem. `today`
 * dilewatkan pemanggilnya — itulah yang membuat seluruhnya dapat diuji tanpa
 * memalsukan waktu.
 */

export type Cadence = 'daily' | 'weekly' | 'monthly';

export interface Schedule {
  cadence: Cadence;
  /** Berapa satuan sekali. 1 = tiap hari/pekan/bulan. Selalu ≥ 1. */
  interval: number;
  /**
   * Hari jangkar untuk irama bulanan, 1–31.
   *
   * Disimpan TERPISAH dari tanggal jalan berikutnya, dan itulah inti seluruh
   * berkas ini. Lihat `nextDate`.
   */
  anchorDay: number;
}

/**
 * Batas jumlah kejadian yang dikejar dalam satu putaran.
 *
 * Aturan harian yang tertidur setahun berutang 365 kejadian. Menulis semuanya
 * dalam satu transaksi basis data mengunci tabel transaksi untuk semua orang;
 * yang tersisa dikerjakan putaran berikutnya, enam puluh detik kemudian.
 */
export const MAX_CATCH_UP = 60;

const DAY_MS = 86_400_000;

function parse(on: string): { year: number; month: number; day: number } {
  const [year, month, day] = on.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

function format(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Jumlah hari dalam sebuah bulan, termasuk aturan kabisat. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Hari dari tanggal mulai — jangkar sebuah aturan bulanan. */
export function anchorFrom(startsOn: string): number {
  return parse(startsOn).day;
}

/**
 * Tanggal kejadian berikutnya sesudah `on`.
 *
 * ── MENGAPA JANGKAR DISIMPAN TERPISAH ───────────────────────────────────
 *
 * Tagihan tanggal 31 tidak punya tanggal 31 di bulan Februari, jadi ia
 * dijepit ke tanggal 28. Bila hasil jepitan itu dipakai sebagai dasar
 * perhitungan berikutnya, Maret akan jatuh tanggal 28 juga — lalu 28 April,
 * dan seterusnya selamanya. Tagihan yang seharusnya jatuh di akhir bulan
 * permanen bergeser maju, dan tidak ada satu baris pun yang terlihat salah.
 *
 * Karena itu penjepitan hanya menyentuh KELUARANNYA. Bulan berikutnya selalu
 * dihitung dari jangkar asli.
 */
export function nextDate(on: string, schedule: Schedule): string {
  const { year, month, day } = parse(on);
  const interval = Math.max(1, Math.trunc(schedule.interval));

  if (schedule.cadence === 'daily' || schedule.cadence === 'weekly') {
    /* Harian dan mingguan adalah penjumlahan hari, bukan penjumlahan kalender:
       "tiap dua pekan" berarti empat belas hari, apa pun panjang bulannya.
       `Date.UTC` dipakai murni sebagai kalkulator hari — tidak ada zona waktu
       yang terlibat karena keduanya UTC di kedua ujungnya. */
    const langkah = schedule.cadence === 'daily' ? interval : interval * 7;
    const geser = new Date(Date.UTC(year, month - 1, day) + langkah * DAY_MS);
    return format(geser.getUTCFullYear(), geser.getUTCMonth() + 1, geser.getUTCDate());
  }

  const anchor = Math.min(31, Math.max(1, Math.trunc(schedule.anchorDay)));
  /* Dinormalkan lewat `Date.UTC`, yang menerima bulan di luar 0–11 dan
     menggulungnya ke tahun berikutnya — Desember + 1 menjadi Januari tahun
     depan tanpa satu pun cabang tambahan. */
  const target = new Date(Date.UTC(year, month - 1 + interval, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth() + 1;

  return format(ty, tm, Math.min(anchor, daysInMonth(ty, tm)));
}

/**
 * Seluruh tanggal yang sudah jatuh tempo, dari `from` sampai `today`.
 *
 * Termasuk `today` itu sendiri: aturan yang jatuh hari ini memang jatuh hari
 * ini. Perbandingan dilakukan sebagai string — `YYYY-MM-DD` berbantalan nol
 * berurut secara leksikografis persis seperti berurut secara kronologis, dan
 * itu menghindari satu perjalanan pulang-pergi ke `Date` per kejadian.
 */
export function dueDates(
  from: string,
  today: string,
  schedule: Schedule,
  endsOn: string | null,
  cap: number = MAX_CATCH_UP,
): string[] {
  const batas = endsOn && endsOn < today ? endsOn : today;
  const hasil: string[] = [];

  let pada = from;
  while (pada <= batas && hasil.length < cap) {
    hasil.push(pada);
    const berikut = nextDate(pada, schedule);
    /* Penjaga, bukan optimisasi. Irama yang entah bagaimana tidak maju akan
       memutar gelung ini selamanya; lebih baik berhenti diam-diam daripada
       menggantung proses. */
    if (berikut <= pada) break;
    pada = berikut;
  }

  return hasil;
}
