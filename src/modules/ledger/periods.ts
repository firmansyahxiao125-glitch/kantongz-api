/**
 * Batas periode.
 *
 * SELURUH periode dihitung dalam zona waktu pengguna, bukan UTC. "Pengeluaran
 * bulan ini" yang dihitung dalam UTC akan salah selama tujuh jam pertama setiap
 * hari di Jakarta — transaksi jam sembilan pagi tanggal satu masuk ke bulan
 * sebelumnya, dan tidak ada yang bisa menjelaskan ke mana uangnya pergi.
 */

export const DEFAULT_TIMEZONE = 'Asia/Jakarta';

export interface Range {
  from: Date;
  to: Date;
}

/**
 * Selisih zona terhadap UTC pada saat tertentu, dalam milidetik.
 *
 * Dihitung lewat `Intl` dan bukan lewat tabel offset: Indonesia punya tiga zona
 * dan aturan waktu musim panas di negara lain berubah tanpa pemberitahuan.
 * `Intl` membaca basis data zona waktu sistem, yang memang dipelihara untuk itu.
 */
function offsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const value = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );

  return asUtc - at.getTime();
}

/** Tengah malam lokal pada tanggal yang memuat `at`, dikembalikan sebagai UTC. */
function startOfLocalDay(at: Date, timeZone: string): Date {
  const shifted = new Date(at.getTime() + offsetMs(timeZone, at));
  shifted.setUTCHours(0, 0, 0, 0);
  /* Digeser balik dengan offset pada tanggal itu sendiri, bukan pada `at` —
     kedua nilainya berbeda tepat pada hari peralihan waktu musim panas. */
  return new Date(shifted.getTime() - offsetMs(timeZone, shifted));
}

export function monthRange(at: Date, timeZone: string = DEFAULT_TIMEZONE): Range {
  const shifted = new Date(at.getTime() + offsetMs(timeZone, at));
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();

  const from = startOfLocalDay(new Date(Date.UTC(year, month, 1, 12)), timeZone);
  const to = new Date(
    startOfLocalDay(new Date(Date.UTC(year, month + 1, 1, 12)), timeZone).getTime() - 1,
  );

  return { from, to };
}

export function previousMonthRange(at: Date, timeZone: string = DEFAULT_TIMEZONE): Range {
  const current = monthRange(at, timeZone);
  /* Satu milidetik sebelum awal bulan ini selalu jatuh di bulan sebelumnya,
     berapa pun panjang bulannya dan apa pun aturan zonanya. */
  return monthRange(new Date(current.from.getTime() - 1), timeZone);
}

export function daysBack(days: number, at: Date, timeZone: string = DEFAULT_TIMEZONE): Range {
  const todayStart = startOfLocalDay(at, timeZone);
  const from = startOfLocalDay(new Date(todayStart.getTime() - (days - 1) * 86_400_000), timeZone);
  const to = new Date(startOfLocalDay(new Date(todayStart.getTime() + 86_400_000 * 1.5), timeZone).getTime() - 1);
  return { from, to };
}

/** Awal periode anggaran yang memuat `at`, sebagai `YYYY-MM-DD` lokal. */
export function periodStart(
  period: 'weekly' | 'monthly' | 'yearly',
  at: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): Range {
  const shifted = new Date(at.getTime() + offsetMs(timeZone, at));

  if (period === 'monthly') return monthRange(at, timeZone);

  if (period === 'yearly') {
    const year = shifted.getUTCFullYear();
    const from = startOfLocalDay(new Date(Date.UTC(year, 0, 1, 12)), timeZone);
    const to = new Date(
      startOfLocalDay(new Date(Date.UTC(year + 1, 0, 1, 12)), timeZone).getTime() - 1,
    );
    return { from, to };
  }

  /* Pekan dimulai Senin. Konvensi ISO-8601, dan konvensi yang dipakai kalender
     Indonesia — pekan yang dimulai Minggu akan membelah akhir pekan menjadi dua
     periode anggaran yang berbeda. */
  const weekday = (shifted.getUTCDay() + 6) % 7;
  const todayStart = startOfLocalDay(at, timeZone);
  const from = startOfLocalDay(new Date(todayStart.getTime() - weekday * 86_400_000), timeZone);
  const to = new Date(
    startOfLocalDay(new Date(from.getTime() + 7 * 86_400_000 + 43_200_000), timeZone).getTime() - 1,
  );
  return { from, to };
}

/**
 * Tengah hari lokal pada sebuah tanggal kalender, sebagai titik waktu UTC.
 *
 * TENGAH HARI, bukan tengah malam. Transaksi tanggal 1 yang disimpan sebagai
 * 00:00 lokal jatuh ke bulan sebelumnya begitu ada pergeseran zona sebesar apa
 * pun — dan pergeseran itu pasti ada, karena laporan dibaca dari zona lain
 * dan basis data menyimpan UTC. Pukul dua belas adalah satu-satunya jam yang
 * bertahan terhadap pergeseran ke dua arah, termasuk peralihan waktu musim
 * panas di negara yang menerapkannya.
 *
 * Ini satu-satunya tempat aturan berulang menyeberang dari kalender ke waktu.
 */
export function localNoon(on: string, timeZone: string = DEFAULT_TIMEZONE): Date {
  const [year, month, day] = on.split('-').map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(year, month - 1, day, 12));
  return new Date(guess.getTime() - offsetMs(timeZone, guess));
}

export function toDateString(at: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
