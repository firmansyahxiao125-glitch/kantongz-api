import { describe, expect, it } from 'vitest';

import { parseReceipt, parseRupiah, parseTanggal } from '../parser.js';

/**
 * Uji pengurai struk. ROADMAP M6.
 *
 * Terhadap teks struk Indonesia yang sungguhan bentuknya — bukan contoh yang
 * dirapikan. Struk asli memuat baris yang membingungkan justru pada tempat yang
 * penting: "Subtotal" di atas "Total", "Total Diskon" di antaranya, dan
 * "Kembali" di bawahnya.
 */

const NOW = new Date(2026, 7, 7, 12);

describe('nominal rupiah', () => {
  /*
   * INI yang paling mudah salah dan paling mahal akibatnya. Format Indonesia
   * memakai titik sebagai pemisah RIBUAN — kebalikan dari format Inggris.
   * `25.000` adalah dua puluh lima ribu, dan membacanya sebagai dua puluh lima
   * membuat setiap struk tercatat seribu kali lebih kecil.
   */
  it('membaca titik sebagai pemisah ribuan', () => {
    expect(parseRupiah('25.000')).toBe(25_000);
    expect(parseRupiah('1.250.000')).toBe(1_250_000);
    expect(parseRupiah('Rp 175.500')).toBe(175_500);
  });

  it('membuang desimal koma yang ditulis struk', () => {
    expect(parseRupiah('25.000,00')).toBe(25_000);
    expect(parseRupiah('1.250.000,00')).toBe(1_250_000);
  });

  it('menerima nominal tanpa pemisah', () => {
    expect(parseRupiah('50000')).toBe(50_000);
    expect(parseRupiah('Rp50000')).toBe(50_000);
  });

  it('menolak yang bukan nominal', () => {
    expect(parseRupiah('')).toBeNull();
    expect(parseRupiah('abc')).toBeNull();
    /* OCR sering menyisipkan huruf ke dalam angka. Yang tercemar ditolak, bukan
       ditebak — angka yang ditebak akan tersimpan tanpa diperiksa. */
    expect(parseRupiah('25O00')).toBeNull();
    expect(parseRupiah('0')).toBeNull();
  });
});

describe('tanggal', () => {
  it('membaca dd/mm/yyyy dan dd-mm-yy', () => {
    expect(new Date(parseTanggal('Tanggal: 15/03/2026', NOW) ?? 0).getMonth()).toBe(2);
    expect(new Date(parseTanggal('15-03-26', NOW) ?? 0).getFullYear()).toBe(2026);
  });

  it('membaca nama bulan Indonesia', () => {
    const parsed = new Date(parseTanggal('7 Agu 2026', NOW) ?? 0);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(7);
  });

  /* Tengah hari, bukan tengah malam — tanggal 1 yang disimpan sebagai 00:00
     lokal jatuh ke bulan sebelumnya begitu ada pergeseran zona. */
  it('menyimpan pada tengah hari lokal', () => {
    expect(new Date(parseTanggal('01/09/2026', NOW) ?? 0).getHours()).toBe(12);
  });

  it('jatuh ke hari ini ketika tidak ada tanggal terbaca', () => {
    expect(parseTanggal('tidak ada tanggal di sini', NOW)).toBe(NOW.getTime());
  });

  it('menolak tanggal yang mustahil', () => {
    /* 45 bukan tanggal. Jatuh ke hari ini, bukan ke tanggal yang dikarang. */
    expect(parseTanggal('45/03/2026', NOW)).toBe(NOW.getTime());
  });
});

describe('struk Indomaret', () => {
  const STRUK = `
INDOMARET
JL. CIKINI RAYA NO 45
JAKARTA PUSAT
TELP 021-3901234

Tanggal: 07/08/2026 14:23

AQUA 600ML          2  7.000
INDOMIE GORENG      3  9.600
ROTI TAWAR          1 18.500

Sub Total          35.100
Total Diskon        2.100
TOTAL              33.000
TUNAI              50.000
KEMBALI            17.000

TERIMA KASIH
`;

  it('mengambil total yang benar, bukan subtotal', () => {
    const draft = parseReceipt(STRUK, NOW);

    /* Subtotal 35.100 muncul DI ATAS total 33.000, dan "Total Diskon" 2.100 di
       antaranya. Pemindaian yang naif akan mengambil salah satu dari keduanya. */
    expect(draft.total).toBe(33_000);
  });

  it('tidak mengambil kembalian sebagai total', () => {
    expect(parseReceipt(STRUK, NOW).total).not.toBe(17_000);
  });

  it('tidak mengambil tunai sebagai total', () => {
    expect(parseReceipt(STRUK, NOW).total).not.toBe(50_000);
  });

  it('mengambil nama merchant dari baris teratas', () => {
    expect(parseReceipt(STRUK, NOW).merchant).toBe('INDOMARET');
  });

  it('mengambil tanggal transaksi', () => {
    const parsed = new Date(parseReceipt(STRUK, NOW).occurredAt ?? 0);
    expect(parsed.getDate()).toBe(7);
    expect(parsed.getMonth()).toBe(7);
  });

  it('membawa baris asal totalnya supaya dapat diperiksa', () => {
    expect(parseReceipt(STRUK, NOW).totalLine).toContain('33.000');
  });
});

describe('struk restoran dengan pajak', () => {
  const STRUK = `
WARUNG NASI PADANG SEDERHANA
Jl. Sudirman Kav 12

Tgl 07/08/2026

Rendang            1  45.000
Nasi Putih         2  10.000
Es Teh             2   8.000

Subtotal              63.000
PPN 11%                6.930
Total Bayar           69.930
`;

  /* "Total Bayar" lebih spesifik daripada "Total", dan PPN harus dilewati meski
     nominalnya muncul tepat di atasnya. */
  it('mengambil total bayar, bukan subtotal maupun PPN', () => {
    expect(parseReceipt(STRUK, NOW).total).toBe(69_930);
  });

  it('mengenali merchant meski namanya panjang', () => {
    expect(parseReceipt(STRUK, NOW).merchant).toBe('WARUNG NASI PADANG SEDERHANA');
  });

  it('menyatakan keyakinan tinggi ketika penanda dan merchant keduanya jelas', () => {
    expect(parseReceipt(STRUK, NOW).confidence).toBe('tinggi');
  });
});

describe('struk yang terbaca buruk', () => {
  /*
   * OCR pada foto miring dan gelap menghasilkan ini. Yang penting BUKAN bahwa
   * pengurainya berhasil — melainkan bahwa ia MENGAKUI kegagalannya alih-alih
   * mengarang angka yang terlihat sah.
   */
  it('mengembalikan total null dan keyakinan rendah', () => {
    const rusak = `
1NDOM4R3T
||| ||||| |||
4QU4 6OOML 7.OOO
T0T4L 33.OOO
`;

    const draft = parseReceipt(rusak, NOW);

    expect(draft.total).toBeNull();
    expect(draft.confidence).toBe('rendah');
  });

  it('tidak pecah pada masukan kosong', () => {
    const draft = parseReceipt('', NOW);

    expect(draft.total).toBeNull();
    expect(draft.merchant).toBeNull();
    expect(draft.confidence).toBe('rendah');
    /* Tanggal tetap terisi hari ini — pengguna dapat mengubahnya. */
    expect(draft.occurredAt).toBe(NOW.getTime());
  });

  it('melewati baris alamat saat mencari merchant', () => {
    const draft = parseReceipt(
      'JL. MERDEKA NO 1\n021-5551234\nTOKO BAHAGIA\nTotal 15.000',
      NOW,
    );

    expect(draft.merchant).toBe('TOKO BAHAGIA');
  });
});

describe('struk minimarket tanpa penanda jelas', () => {
  it('memakai penanda paling spesifik yang tersedia', () => {
    const struk = `
ALFAMART
Jumlah Bayar    27.500
`;
    expect(parseReceipt(struk, NOW).total).toBe(27_500);
  });

  it('menyatakan keyakinan sedang ketika penandanya umum', () => {
    const struk = `
TOKO KELONTONG
Jumlah    12.000
`;
    const draft = parseReceipt(struk, NOW);

    expect(draft.total).toBe(12_000);
    expect(draft.confidence).toBe('sedang');
  });
});
