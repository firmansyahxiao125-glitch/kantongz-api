import { describe, expect, it } from 'vitest';

import { MIN_TUNGGU_HARI, putuskanPembersihan, type BarisTerhapus } from '../pembersihan.js';

/**
 * F4 — keputusan pembersihan, diuji tanpa menghapus apa pun.
 *
 * Satu-satunya cara menguji perilaku yang tidak dapat dibatalkan adalah
 * mengujinya sebagai fungsi murni. Setiap uji di sini menjaga satu penghalang
 * yang berdiri di antara sebuah permintaan dan data yang tidak akan pernah
 * kembali.
 */

const HARI = 86_400_000;
const SEKARANG = new Date('2026-08-15T03:00:00.000Z');

const baris = (id: string, hariLalu: number | null): BarisTerhapus => ({
  id,
  deletedAt: hariLalu === null ? null : new Date(SEKARANG.getTime() - hariLalu * HARI),
});

describe('F4 · yang masih hidup tidak pernah tersentuh', () => {
  it('baris tanpa deletedAt tidak pernah masuk daftar hapus', () => {
    /* Pembersihan bukan penghapusan; ia menuntaskan penghapusan yang sudah
       diminta sebelumnya. Baris hidup yang ikut terhapus di sini adalah data
       yang hilang tanpa seorang pun pernah memintanya. */
    const k = putuskanPembersihan([baris('hidup', null), baris('lama', 90)], SEKARANG, 30);

    expect(k.hapus).toEqual(['lama']);
    expect(k.belumMatang).toEqual([]);
  });

  it('daftar yang seluruhnya hidup tidak menghapus apa pun', () => {
    const k = putuskanPembersihan([baris('a', null), baris('b', null)], SEKARANG, 30);
    expect(k.hapus).toEqual([]);
  });

  it('daftar kosong tidak menghapus apa pun', () => {
    expect(putuskanPembersihan([], SEKARANG, 30).hapus).toEqual([]);
  });
});

describe('F4 · masa tunggu', () => {
  it('yang baru dihapus-lunak BELUM boleh dihapus permanen', () => {
    /* Menghapus permanen sesuatu yang baru saja dihapus-lunak meniadakan
       seluruh gunanya hapus lunak. */
    const k = putuskanPembersihan([baris('kemarin', 1)], SEKARANG, 30);

    expect(k.hapus).toEqual([]);
    expect(k.belumMatang).toEqual(['kemarin']);
  });

  it('tepat pada batas SUDAH boleh', () => {
    const k = putuskanPembersihan([baris('tepat', 30)], SEKARANG, 30);
    expect(k.hapus).toEqual(['tepat']);
  });

  it('sehari sebelum batas belum boleh', () => {
    /* Tepi diuji dua-duanya: `<` yang seharusnya `<=` lulus di semua uji lain
       dan hanya terlihat di sini. */
    const k = putuskanPembersihan([baris('hampir', 29)], SEKARANG, 30);
    expect(k.hapus).toEqual([]);
    expect(k.belumMatang).toEqual(['hampir']);
  });

  it('masa tunggu yang terlalu pendek DIJEPIT, bukan dipatuhi', () => {
    /*
       Uji yang paling penting di berkas ini.

       `tungguHari: 0` berarti "hapus permanen segala yang sudah dihapus-lunak",
       termasuk yang ditekan salah semenit lalu. Konfigurasi yang salah tidak
       boleh menjadi penghapusan yang benar.
    */
    const k = putuskanPembersihan(
      [baris('semenit-lalu', 0), baris('sepekan-lalu', MIN_TUNGGU_HARI + 1)],
      SEKARANG,
      0,
    );

    expect(k.hapus).toEqual(['sepekan-lalu']);
    expect(k.belumMatang).toEqual(['semenit-lalu']);
  });

  it('masa tunggu negatif pun dijepit', () => {
    const k = putuskanPembersihan([baris('baru', 0)], SEKARANG, -365);
    expect(k.hapus).toEqual([]);
  });

  it('masa tunggu yang panjang dipatuhi apa adanya', () => {
    /* Penjepitan hanya berlaku ke satu arah. Server yang memilih menunggu
       setahun berhak menunggu setahun. */
    const k = putuskanPembersihan([baris('setahun-kurang', 300)], SEKARANG, 365);
    expect(k.hapus).toEqual([]);
  });
});

describe('F4 · keputusannya lengkap dan dapat dilaporkan', () => {
  it('setiap baris terhapus muncul di salah satu daftar, tidak pernah keduanya', () => {
    const semua = [baris('a', 100), baris('b', 2), baris('c', 60), baris('d', 5)];
    const k = putuskanPembersihan(semua, SEKARANG, 30);

    expect([...k.hapus, ...k.belumMatang].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(k.hapus.filter((x) => k.belumMatang.includes(x))).toEqual([]);
  });

  it('yang belum matang dilaporkan, bukan disembunyikan', () => {
    /* Pratinjau yang hanya menyebut "3 baris akan dihapus" menyembunyikan
       pertanyaan yang sebenarnya ingin dijawab pengguna: apa yang TIDAK ikut,
       dan kapan ia akan ikut. */
    const k = putuskanPembersihan([baris('nanti', 3)], SEKARANG, 30);
    expect(k.belumMatang).toHaveLength(1);
  });
});
