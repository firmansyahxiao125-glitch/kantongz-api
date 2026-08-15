import { describe, expect, it } from 'vitest';

import { DomainError } from '../../../contracts/domain.js';
import { kategoriUtama, periksaPecahan, type BarisPecahan } from '../pecahan.js';

/**
 * F3 — aturan pemecahan, diuji sebagai aritmetika.
 *
 * Yang dijaga di sini adalah satu janji yang tidak boleh melunak: satu rupiah
 * pun tidak hilang di antara transaksi dan rinciannya.
 */

const SAH = new Set(['cat_makan', 'cat_belanja', 'cat_rumah']);

const baris = (...p: [string, number][]): BarisPecahan[] =>
  p.map(([categoryId, amount]) => ({ categoryId, amount }));

function alasan(jalankan: () => void): { kode: string; pesan: string } {
  try {
    jalankan();
  } catch (error) {
    /* `domainCode`, bukan `code`: `AppError.code` selalu 'unknown' pada
       DomainError, dan kode sebenarnya dibawa terpisah. */
    if (error instanceof DomainError) return { kode: error.domainCode, pesan: error.message };
    return { kode: 'bukan-domain', pesan: String(error) };
  }
  return { kode: 'tidak-melempar', pesan: '' };
}

describe('F3 · pecahan yang sah', () => {
  it('menerima dua baris yang jumlahnya tepat', () => {
    expect(() =>
      periksaPecahan(baris(['cat_makan', 30_000], ['cat_belanja', 20_000]), 50_000, SAH),
    ).not.toThrow();
  });

  it('menerima tiga baris yang jumlahnya tepat', () => {
    expect(() =>
      periksaPecahan(
        baris(['cat_makan', 15_000], ['cat_belanja', 20_000], ['cat_rumah', 15_000]),
        50_000,
        SAH,
      ),
    ).not.toThrow();
  });
});

describe('F3 · satu rupiah pun tidak boleh hilang', () => {
  it('menolak jumlah yang KURANG, sampai satu rupiah', () => {
    /* Selisih satu rupiah adalah kasus yang paling mudah lolos dari
       pemeriksaan yang memakai toleransi — dan justru yang paling merusak,
       karena ia tidak terlihat sampai laporan tahunan tidak cocok. */
    const a = alasan(() =>
      periksaPecahan(baris(['cat_makan', 30_000], ['cat_belanja', 19_999]), 50_000, SAH),
    );

    expect(a.kode).toBe('invalid_input');
    expect(a.pesan).toContain('49999');
    expect(a.pesan).toContain('50000');
  });

  it('menolak jumlah yang LEBIH', () => {
    const a = alasan(() =>
      periksaPecahan(baris(['cat_makan', 30_000], ['cat_belanja', 20_001]), 50_000, SAH),
    );
    expect(a.kode).toBe('invalid_input');
    expect(a.pesan).toContain('selisih 1');
  });

  it('pesannya menyebut kedua angka DAN selisihnya', () => {
    /* Pesan galat yang hanya berkata "jumlah tidak cocok" memaksa pengguna
       menghitung sendiri apa yang sudah dihitung mesin. */
    const a = alasan(() =>
      periksaPecahan(baris(['cat_makan', 10_000], ['cat_belanja', 10_000]), 50_000, SAH),
    );
    expect(a.pesan).toContain('20000');
    expect(a.pesan).toContain('50000');
    expect(a.pesan).toContain('-30000');
  });
});

describe('F3 · bentuk baris', () => {
  it('menolak satu baris — itu bukan pemecahan', () => {
    const a = alasan(() => periksaPecahan(baris(['cat_makan', 50_000]), 50_000, SAH));
    expect(a.kode).toBe('invalid_input');
    expect(a.pesan).toContain('sekurangnya 2');
  });

  it('menolak daftar kosong', () => {
    expect(alasan(() => periksaPecahan([], 50_000, SAH)).kode).toBe('invalid_input');
  });

  it('menolak lebih dari dua puluh baris', () => {
    const banyak = Array.from({ length: 21 }, (_, i) => ({
      categoryId: `cat_${String(i)}`,
      amount: 1_000,
    }));
    expect(alasan(() => periksaPecahan(banyak, 21_000, new Set(banyak.map((b) => b.categoryId)))).pesan).toContain(
      'paling banyak 20',
    );
  });

  it('menolak nominal nol', () => {
    const a = alasan(() =>
      periksaPecahan(baris(['cat_makan', 50_000], ['cat_belanja', 0]), 50_000, SAH),
    );
    expect(a.pesan).toContain('lebih dari nol');
  });

  it('menolak nominal negatif — meski jumlahnya kebetulan cocok', () => {
    /* 60.000 + (-10.000) = 50.000. Pemeriksaan yang hanya menjumlahkan akan
       meloloskannya, dan hasilnya satu kategori dengan belanja negatif. */
    const a = alasan(() =>
      periksaPecahan(baris(['cat_makan', 60_000], ['cat_belanja', -10_000]), 50_000, SAH),
    );
    expect(a.pesan).toContain('lebih dari nol');
  });

  it('menolak nominal pecahan desimal', () => {
    const a = alasan(() =>
      periksaPecahan(baris(['cat_makan', 25_000.5], ['cat_belanja', 24_999.5]), 50_000, SAH),
    );
    expect(a.pesan).toContain('bulat');
  });

  it('menolak kategori yang sama dua kali', () => {
    const a = alasan(() =>
      periksaPecahan(baris(['cat_makan', 30_000], ['cat_makan', 20_000]), 50_000, SAH),
    );
    expect(a.pesan).toContain('sekali');
  });
});

describe('F3 · kepemilikan kategori', () => {
  it('menolak kategori yang bukan milik pengguna', () => {
    const a = alasan(() =>
      periksaPecahan(baris(['cat_makan', 30_000], ['cat_asing', 20_000]), 50_000, SAH),
    );
    expect(a.kode).toBe('not_found');
  });

  it('TIDAK membedakan "tidak ada" dari "milik orang lain"', () => {
    /* Membedakannya mengubah pemecahan menjadi alat pengintai: siapa pun
       dapat menebak id dan mengetahui mana yang benar-benar ada. */
    const hantu = alasan(() =>
      periksaPecahan(baris(['cat_makan', 30_000], ['cat_tidak_ada', 20_000]), 50_000, SAH),
    );
    const oranglain = alasan(() =>
      periksaPecahan(baris(['cat_makan', 30_000], ['cat_milik_bob', 20_000]), 50_000, SAH),
    );

    expect(hantu).toEqual(oranglain);
  });
});

describe('F3 · kategori utama mengisi category_id', () => {
  it('yang nominalnya terbesar', () => {
    expect(kategoriUtama(baris(['cat_makan', 20_000], ['cat_belanja', 30_000]))).toBe('cat_belanja');
  });

  it('seri diputus oleh urutan masukan, bukan oleh id', () => {
    /* Pengguna menuliskan barisnya dalam urutan tertentu; yang pertama di
       antara yang sama besar adalah jawaban yang dapat ia ramalkan. */
    expect(kategoriUtama(baris(['cat_rumah', 25_000], ['cat_belanja', 25_000]))).toBe('cat_rumah');
    expect(kategoriUtama(baris(['cat_belanja', 25_000], ['cat_rumah', 25_000]))).toBe('cat_belanja');
  });

  it('daftar kosong tidak punya kategori utama', () => {
    expect(kategoriUtama([])).toBeNull();
  });
});
