import { describe, expect, it } from 'vitest';

import {
  kunciCabang,
  rapikan,
  sarankanKategori,
  type RiwayatMerchant,
} from '../saran-kategori.js';

/**
 * G2 — saran kategori, diuji sebagai fungsi murni.
 *
 * Yang dijaga di sini bukan cuma "apakah tebakannya benar", melainkan
 * batasan yang membuat fitur ini boleh ada sama sekali: ia MENYARANKAN.
 */

/* Peta nama kategori sistem -> id, seperti yang dilihat satu pengguna. */
const KATEGORI: Record<string, string> = {
  Belanja: 'cat_belanja',
  'Makan & Minum': 'cat_makan',
  Transportasi: 'cat_transport',
  Kesehatan: 'cat_sehat',
  'Tagihan & Utilitas': 'cat_tagihan',
};

const cari = (nama: string): string | null => KATEGORI[nama] ?? null;

const riwayat = (
  ...pasangan: [string, string, number][]
): RiwayatMerchant[] =>
  pasangan.map(([merchant, categoryId, jumlah]) => ({ merchant, categoryId, jumlah }));

describe('G2 · penormalan nama merchant', () => {
  it('menyamakan tulisan yang berbeda huruf besar dan tanda baca', () => {
    expect(rapikan('  indomaret - ciputat!! ')).toBe('INDOMARET CIPUTAT');
  });

  it('kunci cabang membuang penanda cabang', () => {
    expect(kunciCabang('INDOMARET CIPUTAT 2')).toBe('INDOMARET');
    expect(kunciCabang('Indomaret Bintaro')).toBe('INDOMARET');
  });

  it('kata pendek TIDAK berdiri sendiri sebagai kunci', () => {
    /* "RM" cocok dengan setiap rumah makan di Indonesia. Kunci yang terlalu
       pendek menyatukan merchant yang sama sekali tak berhubungan. */
    expect(kunciCabang('RM Padang Sederhana')).toBe('RM PADANG');
    expect(kunciCabang('RM Sunda Kelapa')).toBe('RM SUNDA');
    expect(kunciCabang('RM Padang Sederhana')).not.toBe(kunciCabang('RM Sunda Kelapa'));
  });

  it('nama kosong tidak menghasilkan usulan', () => {
    expect(sarankanKategori('   ', [], cari)).toBeNull();
    expect(sarankanKategori('!!!', [], cari)).toBeNull();
  });
});

describe('G2 · riwayat pengguna mengalahkan kamus', () => {
  it('memakai kebiasaan pengguna, bukan kamus, ketika keduanya berbeda', () => {
    /* INDOMARET ada di kamus sebagai Belanja. Pengguna yang selalu
       menandainya Makan & Minum sedang memberi tahu sesuatu yang lebih benar
       daripada kamus mana pun. */
    const s = sarankanKategori('Indomaret', riwayat(['Indomaret', 'cat_makan', 9]), cari);

    expect(s?.categoryId).toBe('cat_makan');
    expect(s?.sumber).toBe('riwayat');
  });

  it('mencocokkan lintas cabang', () => {
    const s = sarankanKategori(
      'INDOMARET BINTARO',
      riwayat(['INDOMARET CIPUTAT 2', 'cat_belanja', 6]),
      cari,
    );

    expect(s?.categoryId).toBe('cat_belanja');
    expect(s?.alasan).toContain('serupa');
  });

  it('cocok TEPAT lebih dipercaya daripada cocok lintas cabang', () => {
    /* Merchant yang tulisannya sama persis tidak boleh dikalahkan oleh
       tumpukan cabang lain yang kebetulan lebih banyak. */
    const s = sarankanKategori(
      'INDOMARET CIPUTAT',
      riwayat(
        ['INDOMARET CIPUTAT', 'cat_makan', 3],
        ['INDOMARET BINTARO', 'cat_belanja', 40],
      ),
      cari,
    );

    expect(s?.categoryId).toBe('cat_makan');
    expect(s?.alasan).not.toContain('serupa');
  });
});

describe('G2 · keyakinan mencerminkan konsistensi, bukan banyaknya data', () => {
  it('hampir selalu satu kategori → tinggi', () => {
    const s = sarankanKategori(
      'Warung Bu Sri',
      riwayat(['Warung Bu Sri', 'cat_makan', 9], ['Warung Bu Sri', 'cat_belanja', 1]),
      cari,
    );
    expect(s?.keyakinan).toBe('tinggi');
  });

  it('terbagi hampir rata → RENDAH, meski datanya banyak', () => {
    /*
       Uji yang paling penting di berkas ini.

       Seratus transaksi yang terbagi lima puluh-lima puluh bukan bukti kuat
       untuk salah satunya. Sistem yang melaporkan "Belanja, keyakinan tinggi"
       karena 51 lawan 49 sedang berbohong dengan angka besar.
    */
    const s = sarankanKategori(
      'Toko Serba Ada',
      riwayat(['Toko Serba Ada', 'cat_belanja', 51], ['Toko Serba Ada', 'cat_makan', 49]),
      cari,
    );

    expect(s?.keyakinan).toBe('rendah');
  });

  it('sedikit data yang konsisten tetap boleh tinggi', () => {
    const s = sarankanKategori('Kopi Kenangan', riwayat(['Kopi Kenangan', 'cat_makan', 2]), cari);
    expect(s?.keyakinan).toBe('tinggi');
  });

  it('alasannya memuat angkanya, bukan cuma kesimpulannya', () => {
    /* Usulan tanpa sebab tidak dapat dinilai pengguna — dan usulan yang tidak
       dapat dinilai hanya bisa dipercaya atau diabaikan, tidak ditimbang. */
    const s = sarankanKategori(
      'Warung Bu Sri',
      riwayat(['Warung Bu Sri', 'cat_makan', 7], ['Warung Bu Sri', 'cat_belanja', 3]),
      cari,
    );

    expect(s?.alasan).toContain('7 dari 10');
    expect(s?.alasan).toContain('70%');
  });
});

describe('G2 · kamus bawaan', () => {
  it('mengenali merchant Indonesia yang lazim', () => {
    const kasus: [string, string][] = [
      ['ALFAMART CIPUTAT', 'cat_belanja'],
      ['GOJEK', 'cat_transport'],
      ['SPBU PERTAMINA 34', 'cat_transport'],
      ['Apotek Sehat', 'cat_sehat'],
      ['PLN PREPAID', 'cat_tagihan'],
      ['Warung Nasi Ibu', 'cat_makan'],
    ];

    for (const [merchant, harap] of kasus) {
      expect(sarankanKategori(merchant, [], cari)?.categoryId, merchant).toBe(harap);
    }
  });

  it('kamus TIDAK PERNAH berkeyakinan tinggi', () => {
    /* Ia tebakan berdasar nama, bukan berdasar apa yang pernah dilakukan
       orang ini. Menyamakan keduanya menghapus perbedaan yang justru paling
       berguna bagi pengguna. */
    const s = sarankanKategori('ALFAMART', [], cari);
    expect(s?.sumber).toBe('kamus');
    expect(s?.keyakinan).toBe('sedang');
  });

  it('yang cocok PALING PANJANG menang, bukan yang pertama di daftar', () => {
    /* "RUMAH MAKAN" dan "RUMAH SAKIT" sama-sama diawali "RUMAH". Urutan
       daftar tidak boleh menentukan mana yang dipilih. */
    expect(sarankanKategori('RUMAH SAKIT HARAPAN', [], cari)?.categoryId).toBe('cat_sehat');
    expect(sarankanKategori('RUMAH MAKAN SEDERHANA', [], cari)?.categoryId).toBe('cat_makan');
  });

  it('lintas kategori pun panjang yang menentukan, bukan urutan daftar', () => {
    /*
       "RUMAH SAKIT" (11 huruf, Kesehatan) melawan "KOPI" (4, Makan & Minum)
       di dalam satu nama. Belanja/Makan berdiri lebih dulu di KAMUS daripada
       Kesehatan, jadi pemilih yang berhenti pada entri pertama yang cocok
       akan menjawab Makan & Minum untuk sebuah rumah sakit.
    */
    expect(sarankanKategori('RUMAH SAKIT KOPI INDAH', [], cari)?.categoryId).toBe('cat_sehat');
  });

  it('pola pendek TIDAK cocok di tengah kata', () => {
    /*
       Tiga positif palsu yang benar-benar ada di versi pertama, ketika
       pencocokannya memakai `String.includes` mentah:

         "PT INDUSTRI JAYA"  memuat "TRI"   → Pulsa & Internet
         "MOTORS ABC"        memuat "RS"    → Kesehatan
         "HEROIK PERCETAKAN" memuat "HERO"  → Belanja

       Usulan yang percaya diri dan salah adalah bentuk kegagalan yang paling
       cepat membuat orang berhenti membaca usulan sama sekali.
    */
    expect(sarankanKategori('PT INDUSTRI JAYA', [], cari)).toBeNull();
    expect(sarankanKategori('MOTORS ABC', [], cari)).toBeNull();
    expect(sarankanKategori('HEROIK PERCETAKAN', [], cari)).toBeNull();
  });

  it('tetapi kata utuh yang pendek MASIH dikenali', () => {
    /* Penyempitan di atas tidak boleh membuat merchant sungguhan luput. */
    expect(sarankanKategori('RS HARAPAN BUNDA', [], cari)?.categoryId).toBe('cat_sehat');
  });

  it('merchant yang tidak dikenali tidak dipaksakan ke kategori mana pun', () => {
    /* Usulan asal-asalan lebih buruk daripada diam: ia melatih pengguna
       menekan "terima" tanpa membaca. */
    expect(sarankanKategori('QWERTY ZXCV 12345', [], cari)).toBeNull();
  });

  it('kategori yang sudah dihapus pengguna membatalkan usulan, bukan diganti', () => {
    const tanpaTransport = (nama: string): string | null =>
      nama === 'Transportasi' ? null : (KATEGORI[nama] ?? null);

    expect(sarankanKategori('GOJEK', [], tanpaTransport)).toBeNull();
  });
});
