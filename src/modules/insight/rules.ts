/**
 * Kategorisasi otomatis berbasis aturan. ROADMAP M9, tahap pertama.
 *
 * Dijalankan LEBIH DULU, sebelum model apa pun. Alasannya bukan penghematan
 * biaya semata: aturan bersifat deterministik, dapat dijelaskan, dan berjalan
 * dalam mikrodetik. "Indomaret" adalah belanja, dan tidak ada model yang perlu
 * ditanya untuk mengetahuinya.
 *
 * Yang ambigu — dan hanya yang ambigu — diteruskan ke lapisan model di M9 tahap
 * dua. Mengirim semuanya ke model berarti membayar untuk seribu jawaban yang
 * sudah pasti, dan menunggu jaringan untuk hal yang bisa diputuskan seketika.
 */

export interface CategoryRule {
  /** Nama kategori bawaan sistem yang dituju. Harus persis. */
  category: string;
  /** Kata kunci pada nama merchant atau catatan. Dibandingkan huruf kecil. */
  keywords: readonly string[];
}

/**
 * Aturan untuk pola belanja Indonesia.
 *
 * Bukan terjemahan dari daftar Amerika: yang ada di sini adalah merchant dan
 * istilah yang benar-benar muncul di mutasi rekening Indonesia. "Gojek" bisa
 * berarti transportasi atau makanan — dua produk berbeda dari satu merek — dan
 * itulah sebabnya `gofood` dan `grabfood` dicantumkan terpisah dan LEBIH DULU.
 */
export const RULES: readonly CategoryRule[] = [
  /* Pesanan makanan diperiksa sebelum transportasi: "gofood" memuat "go" dan
     "grabfood" memuat "grab". Urutan di sini ADALAH bagian dari aturannya. */
  {
    category: 'Makan & Minum',
    keywords: [
      'gofood', 'grabfood', 'shopeefood', 'warung', 'warteg', 'resto', 'restoran',
      'cafe', 'kafe', 'kopi', 'coffee', 'starbucks', 'kfc', 'mcd', "mcdonald",
      'pizza', 'bakmi', 'sate', 'padang', 'bakso', 'nasi', 'ayam', 'katering',
    ],
  },
  {
    category: 'Transportasi',
    keywords: [
      'gojek', 'goride', 'gocar', 'grab', 'grabbike', 'grabcar', 'maxim', 'inDrive',
      'transjakarta', 'krl', 'mrt', 'lrt', 'kai', 'kereta', 'damri', 'taksi', 'bluebird',
      'pertamina', 'shell', 'spbu', 'bensin', 'parkir', 'tol', 'e-toll', 'etoll',
    ],
  },
  {
    category: 'Belanja',
    keywords: [
      'indomaret', 'alfamart', 'alfamidi', 'superindo', 'hypermart', 'transmart',
      'carrefour', 'giant', 'lotte', 'ranch market', 'tokopedia', 'shopee', 'lazada',
      'bukalapak', 'blibli', 'zalora', 'uniqlo', 'matahari', 'ace hardware', 'informa',
    ],
  },
  {
    category: 'Tagihan & Utilitas',
    keywords: [
      'pln', 'listrik', 'pdam', 'air minum', 'gas negara', 'pgn', 'iuran', 'bpjs',
      'indihome', 'first media', 'biznet', 'myrepublic', 'wifi', 'internet',
    ],
  },
  {
    category: 'Pulsa & Internet',
    keywords: [
      'pulsa', 'telkomsel', 'indosat', 'im3', 'xl axiata', 'axis', 'tri', 'smartfren',
      'by.u', 'kuota', 'paket data',
    ],
  },
  {
    category: 'Kesehatan',
    keywords: [
      'apotek', 'apotik', 'kimia farma', 'guardian', 'century', 'klinik', 'rumah sakit',
      'rs ', 'dokter', 'halodoc', 'alodokter', 'lab ', 'prodia',
    ],
  },
  {
    category: 'Hiburan',
    keywords: [
      'netflix', 'spotify', 'disney', 'vidio', 'viu', 'youtube premium', 'wetv',
      'iflix', 'bioskop', 'cgv', 'xxi', 'cinepolis', 'steam', 'playstation', 'game',
    ],
  },
  {
    category: 'Pendidikan',
    keywords: [
      'spp', 'kuliah', 'sekolah', 'kursus', 'ruangguru', 'zenius', 'udemy', 'coursera',
      'bimbel', 'buku', 'gramedia',
    ],
  },
  {
    category: 'Rumah',
    keywords: ['kontrakan', 'kost', 'kos ', 'sewa rumah', 'ipl', 'iuran warga', 'kebersihan'],
  },
  {
    category: 'Zakat & Donasi',
    keywords: ['zakat', 'infak', 'infaq', 'sedekah', 'donasi', 'baznas', 'dompet dhuafa'],
  },
  {
    category: 'Asuransi',
    keywords: ['asuransi', 'prudential', 'allianz', 'manulife', 'axa', 'premi'],
  },
  {
    category: 'Pajak',
    keywords: ['pajak', 'pbb', 'samsat', 'stnk', 'e-billing', 'djp'],
  },

  /* Pemasukan. Diperiksa hanya untuk transaksi berjenis `income`. */
  { category: 'Gaji', keywords: ['gaji', 'payroll', 'salary', 'thr', 'bonus'] },
  { category: 'Usaha', keywords: ['omzet', 'penjualan', 'invoice', 'termin', 'proyek'] },
  { category: 'Investasi', keywords: ['dividen', 'bunga', 'kupon', 'reksadana', 'saham'] },
];

export interface RuleMatch {
  category: string;
  /** Kata kunci yang mencocokkan — supaya keputusannya dapat dijelaskan. */
  matched: string;
}

/**
 * Mencocokkan teks dengan aturan.
 *
 * Mengembalikan `null` bila tidak ada yang cocok, dan itulah sinyal untuk
 * melanjutkan ke lapisan model. Menebak-nebak di sini akan menghasilkan
 * kategori yang salah dengan percaya diri — jauh lebih buruk daripada tidak
 * berkategori, sebab pengguna tidak akan memeriksanya.
 */
export function matchRule(text: string): RuleMatch | null {
  const haystack = text.toLowerCase();

  for (const rule of RULES) {
    for (const keyword of rule.keywords) {
      if (haystack.includes(keyword.toLowerCase())) {
        return { category: rule.category, matched: keyword };
      }
    }
  }

  return null;
}
