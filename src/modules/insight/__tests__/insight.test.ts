import { describe, expect, it } from 'vitest';

import { findAmountAnomalies, findSubscriptions, monthlyCost, type AmountSample } from '../anomaly.js';
import { daysUntilEmpty, projectCashflow, type DailyFlow } from '../forecast.js';
import { matchRule } from '../rules.js';

/**
 * Uji lapisan wawasan.
 *
 * Seluruhnya fungsi murni — tidak ada basis data, tidak ada jaringan. Itulah
 * yang membuat aturan statistiknya dapat diuji pada kasus yang justru paling
 * penting: yang seharusnya TIDAK memicu apa pun.
 *
 * Deteksi anomali yang terlalu bersemangat lebih berbahaya daripada yang tidak
 * ada. Pengguna yang diberi peringatan setiap minggu berhenti membacanya, dan
 * peringatan yang tidak dibaca sama saja dengan tidak ada.
 */

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

function sample(over: Partial<AmountSample> & { amount: number }): AmountSample {
  return {
    id: `trx_${String(Math.random()).slice(2, 10)}`,
    categoryId: 'cat_makan',
    occurredAt: T0,
    merchant: null,
    ...over,
  };
}

/* ── M9: aturan kategori ─────────────────────────────────────────────── */

describe('aturan kategori', () => {
  it('mengenali merchant Indonesia yang umum', () => {
    expect(matchRule('Indomaret Cikini')?.category).toBe('Belanja');
    expect(matchRule('PLN Prabayar')?.category).toBe('Tagihan & Utilitas');
    expect(matchRule('Bayar Zakat Fitrah')?.category).toBe('Zakat & Donasi');
    expect(matchRule('Telkomsel 50rb')?.category).toBe('Pulsa & Internet');
  });

  /*
   * Satu merek, dua produk. "Gojek" adalah transportasi tetapi "GoFood" adalah
   * makanan — dan "gofood" memuat "go". Urutan aturan ADALAH bagian aturannya,
   * dan uji ini yang menegakkannya.
   */
  it('membedakan pesanan makanan dari transportasi pada merek yang sama', () => {
    expect(matchRule('GoFood - Ayam Geprek')?.category).toBe('Makan & Minum');
    expect(matchRule('GrabFood Nasi Padang')?.category).toBe('Makan & Minum');
    expect(matchRule('Gojek ke kantor')?.category).toBe('Transportasi');
    expect(matchRule('GrabBike')?.category).toBe('Transportasi');
  });

  it('tidak peka huruf besar-kecil', () => {
    expect(matchRule('ALFAMART')?.category).toBe('Belanja');
    expect(matchRule('alfamart')?.category).toBe('Belanja');
  });

  /* Menebak akan menghasilkan kategori yang salah dengan percaya diri, dan
     pengguna tidak akan memeriksanya. `null` adalah jawaban yang benar. */
  it('mengembalikan null ketika tidak ada yang cocok', () => {
    expect(matchRule('Transfer ke Budi')).toBeNull();
    expect(matchRule('')).toBeNull();
  });

  it('membawa kata kunci yang mencocokkan supaya dapat dijelaskan', () => {
    expect(matchRule('Belanja di Superindo')?.matched).toBe('superindo');
  });
});

/* ── M10: nominal janggal ────────────────────────────────────────────── */

describe('deteksi nominal janggal', () => {
  it('menandai nominal yang jauh di atas kebiasaan kategorinya', () => {
    const biasa = Array.from({ length: 20 }, () => sample({ amount: 25_000 + Math.round(Math.random() * 5_000) }));
    const janggal = sample({ amount: 3_000_000, id: 'trx_janggal' });

    const hasil = findAmountAnomalies([...biasa, janggal]);

    expect(hasil.map((a) => a.transactionId)).toContain('trx_janggal');
  });

  /* Sewa rumah lima juta bukan anomali; kopi lima juta jelas anomali. Menilai
     keduanya terhadap rata-rata yang sama akan melewatkan yang kedua dan
     menandai yang pertama. */
  it('menilai per kategori, bukan terhadap seluruh transaksi', () => {
    const kopi = Array.from({ length: 20 }, () => sample({ categoryId: 'cat_kopi', amount: 30_000 }));
    const sewa = Array.from({ length: 20 }, () =>
      sample({ categoryId: 'cat_sewa', amount: 5_000_000 }),
    );

    expect(findAmountAnomalies([...kopi, ...sewa])).toEqual([]);
  });

  it('tidak menandai apa pun ketika sampelnya terlalu sedikit', () => {
    const sedikit = [
      sample({ amount: 20_000 }),
      sample({ amount: 20_000 }),
      sample({ amount: 5_000_000 }),
    ];

    expect(findAmountAnomalies(sedikit)).toEqual([]);
  });

  /* Tagihan tetap: seluruh nominalnya identik, jadi simpangan bakunya nol.
     Membaginya menghasilkan Infinity yang akan menandai semuanya. */
  it('tidak pecah ketika seluruh nominalnya identik', () => {
    const tetap = Array.from({ length: 12 }, () => sample({ amount: 350_000 }));
    expect(findAmountAnomalies(tetap)).toEqual([]);
  });

  it('mengabaikan transaksi tanpa kategori', () => {
    const tanpa = Array.from({ length: 20 }, () =>
      sample({ categoryId: null, amount: 20_000 }),
    );
    expect(findAmountAnomalies([...tanpa, sample({ categoryId: null, amount: 9_000_000 })])).toEqual(
      [],
    );
  });

  /* Belanja yang luar biasa MURAH bukan masalah yang perlu diberitahukan. */
  it('hanya menandai yang di atas rata-rata', () => {
    const biasa = Array.from({ length: 20 }, () => sample({ amount: 1_000_000 }));
    const murah = sample({ amount: 1, id: 'trx_murah' });

    expect(findAmountAnomalies([...biasa, murah]).map((a) => a.transactionId)).not.toContain(
      'trx_murah',
    );
  });
});

/* ── M10: langganan berulang ─────────────────────────────────────────── */

function bulanan(merchant: string, amount: number, count: number, from = T0): AmountSample[] {
  return Array.from({ length: count }, (_, i) =>
    sample({ merchant, amount, occurredAt: from + i * 30 * DAY }),
  );
}

describe('deteksi langganan', () => {
  it('mengenali tagihan bulanan dengan nominal tetap', () => {
    const hasil = findSubscriptions(bulanan('Netflix', 186_000, 6));

    expect(hasil).toHaveLength(1);
    expect(hasil[0]?.merchant).toBe('Netflix');
    expect(hasil[0]?.amount).toBe(186_000);
    expect(hasil[0]?.intervalDays).toBe(30);
    expect(hasil[0]?.occurrences).toBe(6);
  });

  /*
   * INI uji yang paling penting di berkas ini. Tanpa syarat keteraturan jarak,
   * Indomaret akan muncul sebagai langganan bagi hampir semua orang — dan
   * daftar "langganan" yang penuh warung terdekat membuat seluruh fiturnya
   * diabaikan.
   */
  it('TIDAK menganggap belanja rutin sebagai langganan', () => {
    const belanja = [0, 3, 5, 12, 13, 27, 28, 29].map((hari) =>
      sample({ merchant: 'Indomaret', amount: 40_000 + hari * 1_000, occurredAt: T0 + hari * DAY }),
    );

    expect(findSubscriptions(belanja)).toEqual([]);
  });

  it('menolak pola dengan nominal yang berubah-ubah', () => {
    const berubah = Array.from({ length: 6 }, (_, i) =>
      sample({ merchant: 'Warung Kopi', amount: 25_000 + i * 10_000, occurredAt: T0 + i * 30 * DAY }),
    );

    expect(findSubscriptions(berubah)).toEqual([]);
  });

  it('menuntut sekurang-kurangnya tiga kejadian', () => {
    expect(findSubscriptions(bulanan('Spotify', 54_000, 2))).toEqual([]);
    expect(findSubscriptions(bulanan('Spotify', 54_000, 3))).toHaveLength(1);
  });

  it('mengenali siklus mingguan dan tahunan', () => {
    const mingguan = Array.from({ length: 8 }, (_, i) =>
      sample({ merchant: 'Laundry', amount: 35_000, occurredAt: T0 + i * 7 * DAY }),
    );
    const tahunan = Array.from({ length: 3 }, (_, i) =>
      sample({ merchant: 'Domain', amount: 180_000, occurredAt: T0 + i * 365 * DAY }),
    );

    expect(findSubscriptions(mingguan)[0]?.intervalDays).toBe(7);
    expect(findSubscriptions(tahunan)[0]?.intervalDays).toBe(365);
  });

  it('menoleransi tanggal tagih yang bergeser beberapa hari', () => {
    /* Tanggal tagih bergeser karena akhir pekan dan hari libur. Menuntut jarak
       persis akan melewatkan hampir seluruh langganan nyata. */
    const geser = [0, 30, 62, 91, 121].map((hari) =>
      sample({ merchant: 'Disney+', amount: 39_000, occurredAt: T0 + hari * DAY }),
    );

    expect(findSubscriptions(geser)).toHaveLength(1);
  });

  it('menghitung biaya bulanan setara dari siklus apa pun', () => {
    const mingguan = findSubscriptions(
      Array.from({ length: 8 }, (_, i) =>
        sample({ merchant: 'Laundry', amount: 35_000, occurredAt: T0 + i * 7 * DAY }),
      ),
    )[0];

    expect(mingguan && monthlyCost(mingguan)).toBe(150_000);
  });

  it('mengabaikan transaksi tanpa merchant', () => {
    const tanpa = Array.from({ length: 6 }, (_, i) =>
      sample({ merchant: null, amount: 100_000, occurredAt: T0 + i * 30 * DAY }),
    );
    expect(findSubscriptions(tanpa)).toEqual([]);
  });
});

/* ── M12: proyeksi arus kas ──────────────────────────────────────────── */

function flow(days: number, income: number, expense: number): DailyFlow[] {
  return Array.from({ length: days }, (_, i) => ({
    bucket: new Date(T0 + i * DAY).toISOString().slice(0, 10),
    income,
    expense,
  }));
}

describe('proyeksi arus kas', () => {
  it('menolak memproyeksikan dari data yang terlalu sedikit', () => {
    const hasil = projectCashflow(5_000_000, flow(10, 0, 100_000));

    /* Bukan proyeksi dengan pita selebar samudra yang tetap ditampilkan seolah
       bermakna — melainkan pernyataan terbuka bahwa datanya belum cukup. */
    expect(hasil.reliable).toBe(false);
    expect(hasil.points).toEqual([]);
  });

  it('memproyeksikan tiga cakrawala dengan pita ketidakpastian', () => {
    const hasil = projectCashflow(10_000_000, flow(60, 500_000, 400_000));

    expect(hasil.reliable).toBe(true);
    expect(hasil.points.map((p) => p.horizonDays)).toEqual([30, 60, 90]);

    for (const point of hasil.points) {
      expect(point.low).toBeLessThanOrEqual(point.expected);
      expect(point.high).toBeGreaterThanOrEqual(point.expected);
    }
  });

  /*
   * Arus harian yang saling bebas menjumlahkan VARIANSI-nya, jadi simpangan
   * bakunya tumbuh sebagai √n. Pita linear akan terlalu lebar di hari ke-90 dan
   * terlalu sempit di hari ke-30.
   */
  it('melebarkan pita sebagai akar waktu, bukan linear', () => {
    const bervariasi = Array.from({ length: 90 }, (_, i) => ({
      bucket: new Date(T0 + i * DAY).toISOString().slice(0, 10),
      income: i % 30 === 0 ? 8_000_000 : 0,
      expense: 200_000 + (i % 7) * 50_000,
    }));

    const hasil = projectCashflow(10_000_000, bervariasi);
    const [p30, p60, p90] = hasil.points;

    const lebar30 = (p30?.high ?? 0) - (p30?.low ?? 0);
    const lebar90 = (p90?.high ?? 0) - (p90?.low ?? 0);

    expect(p60).toBeDefined();
    /* √3 ≈ 1,73. Linear akan menghasilkan tepat 3. */
    const rasio = lebar90 / lebar30;
    expect(rasio).toBeGreaterThan(1.6);
    expect(rasio).toBeLessThan(1.9);
  });

  it('memproyeksikan saldo turun ketika pengeluaran melampaui pemasukan', () => {
    const hasil = projectCashflow(3_000_000, flow(30, 0, 100_000));

    expect(hasil.dailyNet).toBeLessThan(0);
    expect(hasil.points[0]?.expected).toBeLessThan(3_000_000);
  });

  it('menghitung hari saldo menyentuh nol', () => {
    const hasil = projectCashflow(3_000_000, flow(30, 0, 100_000));
    expect(daysUntilEmpty(hasil)).toBe(30);
  });

  /* Saldo yang naik tidak sedang menuju nol. `null` adalah jawaban yang benar,
     bukan angka besar yang menyiratkan tanggal jatuh tempo yang jauh. */
  it('mengembalikan null ketika saldo tidak menuju nol', () => {
    expect(daysUntilEmpty(projectCashflow(3_000_000, flow(30, 500_000, 100_000)))).toBeNull();
  });

  it('mengembalikan null ketika proyeksinya sendiri tidak dapat dipercaya', () => {
    expect(daysUntilEmpty(projectCashflow(3_000_000, flow(5, 0, 100_000)))).toBeNull();
  });
});
