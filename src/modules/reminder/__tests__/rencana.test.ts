import { describe, expect, it } from 'vitest';

import { kunciPengingat, rencanakanPengingat, UFUK_HARI, type AturanJatuhTempo } from '../rencana.js';

/**
 * G1 — perencana pengingat, diuji sebagai aritmetika tanggal.
 *
 * Setiap uji di sini menjaga satu keputusan yang tertulis di `rencana.ts`.
 * Uji yang tidak dapat menjelaskan keputusan mana yang dijaganya biasanya
 * hanya menegaskan kembali implementasinya.
 */

/* 15 Agustus 2026, 03:00 UTC — pukul sepuluh pagi di Jakarta. Sengaja pagi:
   waktu yang dekat ke tengah malam UTC memilih hari yang berbeda di Jakarta,
   dan uji yang lulus hanya karena jamnya kebetulan tidak menguji zona waktu. */
const SEKARANG = new Date('2026-08-15T03:00:00.000Z');

function aturan(ubah: Partial<AturanJatuhTempo> = {}): AturanJatuhTempo {
  return {
    id: 'rec_1',
    userId: 'usr_1',
    email: 'orang@contoh.id',
    nama: 'Sri',
    judul: 'Langganan Internet',
    jumlah: 350_000,
    nextRunOn: '2026-08-17',
    endsOn: null,
    pausedAt: null,
    ...ubah,
  };
}

describe('G1 · rencanakanPengingat — siapa yang diingatkan', () => {
  it('mengingatkan aturan yang jatuh tempo di dalam ufuk', () => {
    const hasil = rencanakanPengingat([aturan()], SEKARANG);

    expect(hasil).toHaveLength(1);
    expect(hasil[0]?.sisaHari).toBe(2);
    expect(hasil[0]?.jatuhTempo).toBe('2026-08-17');
    expect(hasil[0]?.jumlah).toBe(350_000);
  });

  it('mengingatkan yang jatuh tempo HARI INI — sisaHari 0, bukan dilewati', () => {
    /* Tagihan hari ini justru saat pengingat paling berguna: itu hari
       terakhir saldonya masih bisa disiapkan. */
    const hasil = rencanakanPengingat([aturan({ nextRunOn: '2026-08-15' })], SEKARANG);

    expect(hasil).toHaveLength(1);
    expect(hasil[0]?.sisaHari).toBe(0);
  });

  it('TIDAK mengingatkan yang sudah lewat', () => {
    /* `next_run_on` di masa lalu berarti pekerja berulang yang tertinggal,
       bukan penggunanya yang lupa — dan tidak ada tindakan yang dapat
       diambilnya atas keterlambatan kami. */
    const hasil = rencanakanPengingat([aturan({ nextRunOn: '2026-08-13' })], SEKARANG);
    expect(hasil).toEqual([]);
  });

  it('TIDAK mengingatkan yang masih di luar ufuk', () => {
    const hasil = rencanakanPengingat([aturan({ nextRunOn: '2026-08-19' })], SEKARANG);
    expect(hasil).toEqual([]);
  });

  it('tepi ufuk termasuk — hari ke-3 masih diingatkan, hari ke-4 tidak', () => {
    /* Tepi diuji dua-duanya. Perbandingan `<` yang seharusnya `<=` lulus di
       semua uji lain dan hanya merah di sini. */
    const tepi = rencanakanPengingat([aturan({ nextRunOn: '2026-08-18' })], SEKARANG);
    const lewat = rencanakanPengingat([aturan({ nextRunOn: '2026-08-19' })], SEKARANG);

    expect(tepi.map((p) => p.sisaHari)).toEqual([UFUK_HARI]);
    expect(lewat).toEqual([]);
  });

  it('TIDAK mengingatkan aturan yang dijeda', () => {
    const hasil = rencanakanPengingat([aturan({ pausedAt: new Date() })], SEKARANG);
    expect(hasil).toEqual([]);
  });

  it('TIDAK mengingatkan aturan yang sudah melewati tanggal berakhirnya', () => {
    /* `next_run_on` tidak dikosongkan ketika aturan melewati `ends_on`; ia
       tetap menyimpan tanggal yang tidak akan pernah terjadi. */
    const hasil = rencanakanPengingat(
      [aturan({ nextRunOn: '2026-08-17', endsOn: '2026-08-16' })],
      SEKARANG,
    );
    expect(hasil).toEqual([]);
  });

  it('aturan yang berakhir TEPAT pada jatuh temponya masih diingatkan', () => {
    /* Kejadian terakhir tetap terjadi. `>` yang seharusnya `>=` akan
       membuang justru tagihan penutup, yang biasanya yang paling penting. */
    const hasil = rencanakanPengingat(
      [aturan({ nextRunOn: '2026-08-17', endsOn: '2026-08-17' })],
      SEKARANG,
    );
    expect(hasil).toHaveLength(1);
  });
});

describe('G1 · kunci idempotensi', () => {
  it('kuncinya terikat pada TANGGAL JATUH TEMPO, bukan tanggal kirim', () => {
    /*
       Uji yang paling penting di berkas ini.

       Kunci berbasis tanggal kirim lulus setiap uji lain di sini dan mengirim
       satu email tiap hari selama aturannya di dalam ufuk. Yang membuktikan
       bedanya hanya ini: perencana dijalankan pada tiga hari yang berlainan
       untuk kejadian yang sama, dan kuncinya harus tidak bergerak.
    */
    const hari = ['2026-08-15', '2026-08-16', '2026-08-17'].map(
      (d) => new Date(`${d}T03:00:00.000Z`),
    );

    const kunci = hari.map((t) => {
      const hasil = rencanakanPengingat([aturan({ nextRunOn: '2026-08-17' })], t);
      return hasil[0]?.kunci;
    });

    expect(kunci).toEqual([
      'pengingat:rec_1:2026-08-17',
      'pengingat:rec_1:2026-08-17',
      'pengingat:rec_1:2026-08-17',
    ]);
    expect(new Set(kunci).size).toBe(1);
  });

  it('kejadian BERIKUTNYA dari aturan yang sama mendapat kunci berbeda', () => {
    /* Idempotensi yang terlalu kuat sama rusaknya: langganan bulanan harus
       mengingatkan lagi bulan depan. */
    const agustus = kunciPengingat('rec_1', '2026-08-17');
    const september = kunciPengingat('rec_1', '2026-09-17');
    expect(agustus).not.toBe(september);
  });

  it('dua aturan yang jatuh tempo pada hari yang sama tidak saling menutup', () => {
    const hasil = rencanakanPengingat(
      [aturan({ id: 'rec_a' }), aturan({ id: 'rec_b' })],
      SEKARANG,
    );
    expect(new Set(hasil.map((p) => p.kunci)).size).toBe(2);
  });
});

describe('G1 · urutan dan zona waktu', () => {
  it('yang paling mendesak lebih dulu', () => {
    const hasil = rencanakanPengingat(
      [
        aturan({ id: 'jauh', nextRunOn: '2026-08-18' }),
        aturan({ id: 'dekat', nextRunOn: '2026-08-15' }),
        aturan({ id: 'tengah', nextRunOn: '2026-08-16' }),
      ],
      SEKARANG,
    );
    expect(hasil.map((p) => p.ruleId)).toEqual(['dekat', 'tengah', 'jauh']);
  });

  it('harinya dihitung di Jakarta, bukan di UTC', () => {
    /*
       17 Agustus pukul 19:00 UTC sudah tanggal 18 di Jakarta. Perencana yang
       memakai `toISOString()` akan menghitung sisa satu hari untuk tagihan
       yang sebenarnya jatuh tempo HARI INI.
    */
    const malam = new Date('2026-08-17T19:00:00.000Z');
    const hasil = rencanakanPengingat([aturan({ nextRunOn: '2026-08-18' })], malam);

    expect(hasil[0]?.sisaHari).toBe(0);
  });

  it('tidak mengembalikan apa pun untuk daftar kosong', () => {
    expect(rencanakanPengingat([], SEKARANG)).toEqual([]);
  });
});
