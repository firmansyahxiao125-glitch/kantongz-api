import { describe, expect, it } from 'vitest';

import { MAX_CATCH_UP, anchorFrom, dueDates, nextDate, type Schedule } from '../schedule.js';

/**
 * Aritmetika kalender aturan berulang.
 *
 * Diuji sendirian, tanpa basis data dan tanpa zona waktu, karena di sinilah
 * seluruh kesalahan yang mahal hidup: tanggal 31 di bulan yang tidak punya
 * tanggal 31, tahun kabisat, dan jangkar yang diam-diam bergeser mundur
 * sesudah satu bulan pendek.
 */

const harian = (interval = 1): Schedule => ({ cadence: 'daily', interval, anchorDay: 1 });
const mingguan = (interval = 1): Schedule => ({ cadence: 'weekly', interval, anchorDay: 1 });
const bulanan = (anchorDay: number, interval = 1): Schedule => ({
  cadence: 'monthly',
  interval,
  anchorDay,
});

describe('nextDate — harian', () => {
  it('maju satu hari', () => {
    expect(nextDate('2026-08-14', harian())).toBe('2026-08-15');
  });

  it('menyeberangi akhir bulan', () => {
    expect(nextDate('2026-08-31', harian())).toBe('2026-09-01');
  });

  it('menyeberangi akhir tahun', () => {
    expect(nextDate('2026-12-31', harian())).toBe('2027-01-01');
  });

  it('menghormati jarak lebih dari satu hari', () => {
    expect(nextDate('2026-08-14', harian(3))).toBe('2026-08-17');
  });

  it('29 Februari ada di tahun kabisat', () => {
    expect(nextDate('2028-02-28', harian())).toBe('2028-02-29');
  });

  it('dan tidak ada di tahun biasa', () => {
    expect(nextDate('2026-02-28', harian())).toBe('2026-03-01');
  });
});

describe('nextDate — mingguan', () => {
  it('maju tujuh hari', () => {
    expect(nextDate('2026-08-14', mingguan())).toBe('2026-08-21');
  });

  it('dua pekan adalah empat belas hari, bukan setengah bulan', () => {
    expect(nextDate('2026-08-14', mingguan(2))).toBe('2026-08-28');
  });

  it('mempertahankan hari dalam pekan', () => {
    /* 14 Agustus 2026 adalah Jumat; hasilnya wajib Jumat juga. */
    const hasil = nextDate('2026-08-14', mingguan(3));
    expect(hasil).toBe('2026-09-04');
    expect(new Date(`${hasil}T12:00:00Z`).getUTCDay()).toBe(5);
  });
});

describe('nextDate — bulanan', () => {
  it('maju satu bulan pada hari yang sama', () => {
    expect(nextDate('2026-08-14', bulanan(14))).toBe('2026-09-14');
  });

  it('tanggal 31 dijepit ke akhir bulan yang lebih pendek', () => {
    expect(nextDate('2026-01-31', bulanan(31))).toBe('2026-02-28');
  });

  it('DAN JANGKARNYA TIDAK IKUT BERGESER', () => {
    /*
     * Inilah kesalahan yang paling sering terjadi dan paling lama tidak
     * ketahuan: menyimpan hasil jepitan sebagai jangkar berikutnya membuat
     * 31 Januari menjadi 28 Februari lalu 28 Maret — dan sesudah itu tagihan
     * yang jatuh akhir bulan permanen bergeser tiga hari lebih awal.
     */
    expect(nextDate('2026-02-28', bulanan(31))).toBe('2026-03-31');
    expect(nextDate('2026-03-31', bulanan(31))).toBe('2026-04-30');
    expect(nextDate('2026-04-30', bulanan(31))).toBe('2026-05-31');
  });

  it('tanggal 30 dijepit di Februari saja', () => {
    expect(nextDate('2026-01-30', bulanan(30))).toBe('2026-02-28');
    expect(nextDate('2026-02-28', bulanan(30))).toBe('2026-03-30');
  });

  it('Februari kabisat menerima tanggal 29', () => {
    expect(nextDate('2028-01-31', bulanan(31))).toBe('2028-02-29');
  });

  it('tiga bulan sekali', () => {
    expect(nextDate('2026-01-31', bulanan(31, 3))).toBe('2026-04-30');
    expect(nextDate('2026-04-30', bulanan(31, 3))).toBe('2026-07-31');
  });

  it('menyeberangi tahun', () => {
    expect(nextDate('2026-12-15', bulanan(15))).toBe('2027-01-15');
  });
});

describe('anchorFrom', () => {
  it('mengambil hari dari tanggal mulai', () => {
    expect(anchorFrom('2026-08-14')).toBe(14);
    expect(anchorFrom('2026-01-31')).toBe(31);
    expect(anchorFrom('2026-02-28')).toBe(28);
  });
});

describe('dueDates', () => {
  it('belum jatuh tempo menghasilkan kosong', () => {
    expect(dueDates('2026-08-20', '2026-08-14', harian(), null, MAX_CATCH_UP)).toEqual([]);
  });

  it('jatuh tempo hari ini ikut terhitung', () => {
    expect(dueDates('2026-08-14', '2026-08-14', harian(), null, MAX_CATCH_UP)).toEqual([
      '2026-08-14',
    ]);
  });

  it('mengejar ketertinggalan seluruhnya', () => {
    expect(dueDates('2026-08-10', '2026-08-14', harian(), null, MAX_CATCH_UP)).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
    ]);
  });

  it('berhenti di tanggal berakhir, bukan di hari ini', () => {
    expect(dueDates('2026-08-10', '2026-08-14', harian(), '2026-08-12', MAX_CATCH_UP)).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
    ]);
  });

  it('tanggal berakhir sebelum mulai menghasilkan kosong', () => {
    expect(dueDates('2026-08-10', '2026-08-14', harian(), '2026-08-09', MAX_CATCH_UP)).toEqual([]);
  });

  it('bulanan yang tertinggal setengah tahun', () => {
    expect(dueDates('2026-01-31', '2026-06-15', bulanan(31), null, MAX_CATCH_UP)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });

  it('dibatasi supaya satu putaran tidak menulis ribuan baris', () => {
    expect(dueDates('2020-01-01', '2026-08-14', harian(), null, 5)).toEqual([
      '2020-01-01',
      '2020-01-02',
      '2020-01-03',
      '2020-01-04',
      '2020-01-05',
    ]);
  });

  it('batasnya nyata dan bukan sekadar saran', () => {
    /* Tanpa batas, aturan harian dengan tanggal mulai jauh di belakang akan
       menulis ribuan transaksi dalam satu transaksi basis data dan mengunci
       tabelnya untuk semua orang. */
    expect(dueDates('2020-01-01', '2026-08-14', harian(), null, MAX_CATCH_UP)).toHaveLength(
      MAX_CATCH_UP,
    );
  });

  it('hasilnya selalu menaik dan tanpa kembar', () => {
    const hasil = dueDates('2026-01-01', '2026-12-31', bulanan(31), null, MAX_CATCH_UP);
    expect([...hasil].sort()).toEqual(hasil);
    expect(new Set(hasil).size).toBe(hasil.length);
  });
});
