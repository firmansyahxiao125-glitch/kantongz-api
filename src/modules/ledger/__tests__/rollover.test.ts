import { describe, expect, it } from 'vitest';

import { previousPeriods, toDateString } from '../periods.js';
import { MAX_ROLLOVER_PERIODS, carryOverOf, limitOf } from '../rollover.js';

/**
 * Aritmetika bawaan sisa anggaran.
 *
 * Diuji sendirian karena inilah bagian yang menentukan berapa besar amplop
 * bulan ini. Salah di sini menghasilkan batas yang terlihat wajar dan tidak
 * berhubungan dengan apa pun.
 */

describe('carryOverOf', () => {
  it('tanpa periode sebelumnya, tidak ada bawaan', () => {
    expect(carryOverOf(1_000_000, [])).toBe(0);
  });

  it('sisa satu periode terbawa utuh', () => {
    expect(carryOverOf(1_000_000, [700_000])).toBe(300_000);
  });

  it('periode yang tidak dipakai sama sekali membawa seluruh jatahnya', () => {
    expect(carryOverOf(1_000_000, [0])).toBe(1_000_000);
  });

  it('BERANTAI, bukan penjumlahan sisa masing-masing', () => {
    /*
     * Amplop periode ini adalah jatah DITAMBAH bawaan, dan yang tersisa
     * darinya menjadi bawaan berikutnya.
     *
     *   p1: 1.000.000 − 700.000            =   300.000
     *   p2: 1.000.000 + 300.000 − 1.500.000 =  -200.000
     *   p3: 1.000.000 − 200.000 − 400.000   =   400.000
     */
    expect(carryOverOf(1_000_000, [700_000, 1_500_000, 400_000])).toBe(400_000);
  });

  it('periode yang jebol menghasilkan bawaan NEGATIF', () => {
    /* Bawaan yang hanya positif adalah anggaran yang tidak pernah menagih
       apa pun: bulan yang jebol akan hangus tanpa jejak. */
    expect(carryOverOf(1_000_000, [1_300_000])).toBe(-300_000);
  });

  it('utang ikut ke periode berikutnya', () => {
    expect(carryOverOf(1_000_000, [1_300_000, 1_000_000])).toBe(-300_000);
  });

  it('dua belas periode kosong membawa dua belas jatah', () => {
    expect(carryOverOf(500_000, Array.from({ length: 12 }, () => 0))).toBe(6_000_000);
  });
});

describe('limitOf', () => {
  it('jatah ditambah bawaan', () => {
    expect(limitOf(1_000_000, 300_000)).toBe(1_300_000);
  });

  it('bawaan negatif menipiskan amplopnya', () => {
    expect(limitOf(1_000_000, -300_000)).toBe(700_000);
  });

  it('TIDAK PERNAH negatif', () => {
    /* Batas negatif akan membuat bilah kemajuan membagi dengan angka negatif
       dan menampilkan persentase yang tidak berarti apa-apa. Utangnya tetap
       terlihat lewat `carryOver` yang dilaporkan apa adanya. */
    expect(limitOf(1_000_000, -1_500_000)).toBe(0);
  });
});

describe('previousPeriods', () => {
  const WIB = 'Asia/Jakarta';

  it('bulanan mundur satu per satu, terlama dulu', () => {
    const hasil = previousPeriods('monthly', new Date('2026-08-14T05:00:00Z'), 3, WIB);
    expect(hasil.map((r) => toDateString(r.from, WIB))).toEqual([
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
    ]);
  });

  it('tidak pernah memuat periode berjalan', () => {
    const hasil = previousPeriods('monthly', new Date('2026-08-14T05:00:00Z'), 12, WIB);
    expect(hasil.map((r) => toDateString(r.from, WIB))).not.toContain('2026-08-01');
  });

  it('menyeberangi tahun tanpa salah hitung', () => {
    const hasil = previousPeriods('monthly', new Date('2026-01-15T05:00:00Z'), 2, WIB);
    expect(hasil.map((r) => toDateString(r.from, WIB))).toEqual(['2025-11-01', '2025-12-01']);
  });

  it('Februari yang pendek tidak menggeser bulan lain', () => {
    /* Aritmetika "kurangi 30 hari" akan melewati Februari sama sekali. */
    const hasil = previousPeriods('monthly', new Date('2026-04-15T05:00:00Z'), 3, WIB);
    expect(hasil.map((r) => toDateString(r.from, WIB))).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  });

  it('mingguan mundur tujuh hari dan mulai Senin', () => {
    const hasil = previousPeriods('weekly', new Date('2026-08-14T05:00:00Z'), 2, WIB);
    const mulai = hasil.map((r) => toDateString(r.from, WIB));
    expect(mulai).toEqual(['2026-07-27', '2026-08-03']);
    for (const m of mulai) {
      expect(new Date(`${m}T12:00:00Z`).getUTCDay()).toBe(1);
    }
  });

  it('tahunan mundur satu tahun', () => {
    const hasil = previousPeriods('yearly', new Date('2026-08-14T05:00:00Z'), 2, WIB);
    expect(hasil.map((r) => toDateString(r.from, WIB))).toEqual(['2024-01-01', '2025-01-01']);
  });

  it('rentangnya bersambung tanpa celah dan tanpa tumpang tindih', () => {
    const hasil = previousPeriods('monthly', new Date('2026-08-14T05:00:00Z'), MAX_ROLLOVER_PERIODS, WIB);
    for (let i = 1; i < hasil.length; i += 1) {
      const sebelum = hasil[i - 1];
      const kini = hasil[i];
      if (!sebelum || !kini) throw new Error('rentang hilang');
      /* Akhir periode sebelumnya tepat satu milidetik sebelum awal
         berikutnya — satu detik pun celah berarti transaksi yang jatuh di
         sana tidak terhitung di periode mana pun. */
      expect(kini.from.getTime() - sebelum.to.getTime()).toBe(1);
    }
  });
});
