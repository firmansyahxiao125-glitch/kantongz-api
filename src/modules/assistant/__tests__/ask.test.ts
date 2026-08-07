import { describe, expect, it } from 'vitest';

import { PERIOD_LABEL, resolveQuestion } from '../intent.js';

/**
 * Uji pengenal maksud. ROADMAP M13.
 *
 * Fungsi murni, tanpa basis data — dan itulah yang membuat kasus yang paling
 * penting dapat diuji: pertanyaan yang TIDAK boleh dikenali.
 *
 * Menebak maksud menghasilkan angka yang benar untuk pertanyaan yang salah, dan
 * pengguna yang menerima jawaban meyakinkan atas pertanyaan lain tidak punya
 * cara mengetahuinya. Itu lebih berbahaya daripada menolak menjawab.
 */

describe('maksud pertanyaan', () => {
  it('mengenali pertanyaan pengeluaran', () => {
    expect(resolveQuestion('berapa pengeluaranku bulan ini?')?.intent).toBe('spend_total');
    expect(resolveQuestion('aku habis berapa minggu ini')?.intent).toBe('spend_total');
  });

  it('mengenali pertanyaan pemasukan', () => {
    expect(resolveQuestion('berapa pemasukanku bulan lalu')?.intent).toBe('income_total');
    expect(resolveQuestion('gaji bulan ini berapa')?.intent).toBe('income_total');
  });

  it('mengenali pertanyaan saldo', () => {
    expect(resolveQuestion('berapa saldoku sekarang')?.intent).toBe('balance');
    expect(resolveQuestion('aku punya berapa')?.intent).toBe('balance');
  });

  it('mengenali pertanyaan rincian kategori', () => {
    expect(resolveQuestion('ke mana uangku pergi bulan ini')?.intent).toBe('top_categories');
    expect(resolveQuestion('uangku habis untuk apa saja')?.intent).toBe('top_categories');
  });

  it('mengenali pertanyaan transaksi terbesar', () => {
    expect(resolveQuestion('pengeluaran terbesarku apa')?.intent).toBe('largest_expense');
    expect(resolveQuestion('belanja paling mahal bulan lalu')?.intent).toBe('largest_expense');
  });

  it('mengenali pertanyaan anggaran, langganan, dan ketahanan saldo', () => {
    expect(resolveQuestion('anggaranku bagaimana')?.intent).toBe('budget_status');
    expect(resolveQuestion('langgananku apa saja')?.intent).toBe('subscriptions');
    expect(resolveQuestion('saldoku cukup sampai kapan')?.intent).toBe('runway');
  });

  it('mengenali pertanyaan selisih', () => {
    expect(resolveQuestion('bulan ini aku nabung berapa')?.intent).toBe('net_flow');
    expect(resolveQuestion('berapa selisih pemasukan dan pengeluaran')?.intent).toBe('net_flow');
  });
});

describe('urutan prioritas', () => {
  /*
   * Urutan aturan ADALAH aturannya. "Langganan" adalah pengeluaran, dan
   * "saldoku cukup sampai kapan" memuat "saldo" — keduanya akan tertangkap
   * aturan yang lebih umum bila urutannya terbalik.
   */
  it('langganan menang atas pengeluaran umum', () => {
    expect(resolveQuestion('berapa pengeluaran langgananku')?.intent).toBe('subscriptions');
  });

  it('ketahanan saldo menang atas saldo', () => {
    expect(resolveQuestion('saldoku bertahan sampai kapan')?.intent).toBe('runway');
  });

  it('terbesar menang atas pengeluaran umum', () => {
    expect(resolveQuestion('pengeluaran terbesarku')?.intent).toBe('largest_expense');
  });
});

describe('periode', () => {
  it('bawaan adalah bulan ini', () => {
    expect(resolveQuestion('berapa pengeluaranku')?.period).toBe('this_month');
  });

  it('mengenali bulan lalu, minggu ini, dan rentang hari', () => {
    expect(resolveQuestion('pengeluaran bulan lalu')?.period).toBe('last_month');
    expect(resolveQuestion('pengeluaran minggu ini')?.period).toBe('last_7_days');
    expect(resolveQuestion('pengeluaran 30 hari terakhir')?.period).toBe('last_30_days');
    expect(resolveQuestion('pengeluaran 3 bulan terakhir')?.period).toBe('last_90_days');
  });

  it('punya label untuk setiap periode', () => {
    for (const period of Object.keys(PERIOD_LABEL)) {
      expect(PERIOD_LABEL[period as keyof typeof PERIOD_LABEL].length).toBeGreaterThan(3);
    }
  });
});

describe('kategori yang disebut', () => {
  it('mengambil kata kategori sesudah "untuk"', () => {
    const hasil = resolveQuestion('berapa yang kuhabiskan untuk makan');

    expect(hasil?.intent).toBe('spend_by_category');
    expect(hasil?.categoryHint).toBe('makan');
  });

  /* "berapa untuk makan bulan ini" harus menghasilkan "makan", bukan
     "makan bulan ini" — sisanya menerangkan waktu, bukan kategori. */
  it('berhenti pada kata periode', () => {
    expect(resolveQuestion('berapa untuk transportasi bulan lalu')?.categoryHint).toBe(
      'transportasi',
    );
  });

  it('mengambil kategori bernama lebih dari satu kata', () => {
    expect(resolveQuestion('berapa untuk makan dan minum')?.categoryHint).toBe('makan dan minum');
  });
});

describe('yang TIDAK boleh dikenali', () => {
  /*
   * INI bagian terpenting di berkas ini. Pertanyaan di luar cakupan harus
   * mengembalikan null supaya lapisan atasnya menjawab "aku belum bisa" —
   * bukan menjawab pertanyaan lain dengan angka yang kebetulan benar.
   */
  it('menolak pertanyaan di luar cakupan', () => {
    expect(resolveQuestion('siapa presiden Indonesia')).toBeNull();
    expect(resolveQuestion('bagaimana cuaca hari ini')).toBeNull();
    expect(resolveQuestion('ceritakan sebuah lelucon')).toBeNull();
  });

  it('menolak masukan kosong dan terlalu pendek', () => {
    expect(resolveQuestion('')).toBeNull();
    expect(resolveQuestion('  ')).toBeNull();
    expect(resolveQuestion('ap')).toBeNull();
  });

  /* "untuk" muncul di hampir setiap kalimat. Tanpa kategori yang tersisa
     sesudahnya, pertanyaannya bukan tentang kategori. */
  it('menolak "untuk" yang tidak diikuti kategori', () => {
    expect(resolveQuestion('untuk')).toBeNull();
    expect(resolveQuestion('buat')).toBeNull();
  });

  it('menolak pertanyaan yang meminta nasihat investasi', () => {
    /* Tidak dikenali berarti tidak dijawab. Nasihat investasi bukan sesuatu
       yang boleh keluar dari aplikasi ini. */
    expect(resolveQuestion('saham apa yang bagus')).toBeNull();
    expect(resolveQuestion('sebaiknya aku investasi di mana')).toBeNull();
  });
});

describe('penjelasan keputusan', () => {
  it('membawa kata yang mencocokkan', () => {
    expect(resolveQuestion('berapa saldoku')?.matched).toBe('saldo');
    expect(resolveQuestion('langgananku apa saja')?.matched).toBe('langganan');
  });

  it('tidak peka huruf besar-kecil', () => {
    expect(resolveQuestion('BERAPA SALDOKU')?.intent).toBe('balance');
  });
});
