/**
 * Menyarankan kategori dari nama merchant. G2.
 *
 * ── MENYARANKAN, TIDAK MEMUTUSKAN ──────────────────────────────────────
 *
 * Batasan yang paling menentukan bentuk berkas ini, dan satu-satunya yang
 * tidak boleh dilanggar: tidak ada satu pun jalur di sini yang menulis.
 * Fungsi ini mengembalikan usulan; manusia yang memilih.
 *
 * Sebabnya bukan kehati-hatian yang berlebihan. Kategori salah yang dipasang
 * otomatis merusak DUA hal sekaligus dan diam-diam: anggaran bulan itu
 * menghitung pengeluaran ke pos yang keliru, dan laporan tahunan mewarisi
 * kesalahannya. Pengguna baru menyadarinya ketika angkanya sudah dipakai
 * mengambil keputusan — dan pada saat itu tidak ada yang tahu baris mana yang
 * ditebak mesin dan mana yang benar-benar dipilih orang.
 *
 * Usulan yang salah dibuang dengan satu ketukan. Itu asimetri yang membenarkan
 * seluruh rancangan ini.
 *
 * ── RIWAYAT PENGGUNA MENGALAHKAN KAMUS, SELALU ─────────────────────────
 *
 * "INDOMARET" ada di kamus sebagai Belanja. Tetapi pengguna yang selama enam
 * bulan menandainya Makan & Minum — karena ia memang hanya membeli makan siang
 * di sana — sedang memberi tahu sesuatu yang jauh lebih benar daripada kamus
 * mana pun. Kebiasaannya sendiri yang menang.
 *
 * ── DAN KETIKA RIWAYATNYA SENDIRI TIDAK KONSISTEN, KEYAKINANNYA TURUN ──
 *
 * Merchant yang setengah waktu ditandai Belanja dan setengahnya Makan bukan
 * merchant yang jawabannya "Belanja, 51%". Ia merchant yang jawabannya "saya
 * tidak tahu", dan mengatakannya jauh lebih berguna daripada menebak dengan
 * percaya diri.
 */

export type Keyakinan = 'tinggi' | 'sedang' | 'rendah';

export interface RiwayatMerchant {
  /** Nama merchant seperti tertulis di transaksi. */
  merchant: string;
  categoryId: string;
  /** Berapa kali pasangan itu muncul. */
  jumlah: number;
}

export interface Saran {
  categoryId: string;
  keyakinan: Keyakinan;
  /** Kalimat yang dapat ditunjukkan apa adanya kepada pengguna. */
  alasan: string;
  /** Dari mana usulnya datang. Dipakai UI untuk membedakan nadanya. */
  sumber: 'riwayat' | 'kamus';
}

/* ── penormalan ──────────────────────────────────────────────────────── */

/**
 * Merapikan nama merchant supaya dua tulisan yang sama dapat bertemu.
 *
 * TIDAK memperbaiki kekeliruan OCR. Itu tugas `receipt/parser.ts`, dan
 * mengulanginya di sini berarti dua tempat yang harus berubah bersama-sama —
 * yang berarti suatu hari hanya satu yang berubah.
 */
export function rapikan(merchant: string): string {
  return merchant
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Kunci cabang: nama yang sama tanpa penanda cabangnya.
 *
 * "INDOMARET CIPUTAT 2" dan "INDOMARET BINTARO" adalah merchant yang sama bagi
 * seseorang yang sedang memilih kategori, dan tulisan yang berbeda bagi
 * pencocokan tepat. Yang diambil hanya kata pertama yang cukup panjang untuk
 * berarti sesuatu.
 *
 * Ambang empat huruf diukur terhadap daftar merchant Indonesia yang lazim:
 * "RM", "PT", "CV", "UD", "KFC" jatuh di bawahnya dan memang tidak boleh
 * menjadi kunci sendirian — "RM" cocok dengan setiap rumah makan di negeri
 * ini. Untuk kasus itu dua kata pertama dipakai bersama.
 */
export function kunciCabang(merchant: string): string {
  const kata = rapikan(merchant).split(' ').filter((k) => k.length > 0);
  if (kata.length === 0) return '';

  const pertama = kata[0] ?? '';
  if (pertama.length >= 4) return pertama;
  return kata.slice(0, 2).join(' ');
}

/* ── kamus bawaan ────────────────────────────────────────────────────── */

/**
 * Merchant Indonesia yang lazim, dipetakan ke NAMA kategori sistem.
 *
 * Nama, bukan id: id kategori sistem berbeda di tiap basis data karena
 * ditanam saat boot. Pemanggilnya yang menerjemahkan nama menjadi id milik
 * pengguna yang bersangkutan.
 *
 * Daftarnya sengaja pendek dan hanya berisi yang benar-benar tak
 * terbantahkan. Kamus yang panjang dan setengah benar menghasilkan usulan
 * yang sering meleset, dan usulan yang sering meleset akan diabaikan orang —
 * termasuk pada kali yang ia benar.
 */
const KAMUS: { pola: string[]; kategori: string }[] = [
  {
    kategori: 'Belanja',
    pola: ['INDOMARET', 'ALFAMART', 'ALFAMIDI', 'SUPERINDO', 'HYPERMART', 'TRANSMART', 'HERO', 'LOTTE', 'CARREFOUR', 'GIANT', 'RANCH MARKET', 'YOGYA', 'MATAHARI'],
  },
  {
    kategori: 'Makan & Minum',
    pola: ['WARUNG', 'WARTEG', 'RUMAH MAKAN', 'RESTORAN', 'KOPI', 'COFFEE', 'STARBUCKS', 'KFC', 'MCDONALD', 'MCD', 'BURGER KING', 'PIZZA HUT', 'HOKBEN', 'SOLARIA', 'BAKMI', 'SATE', 'BAKSO', 'PADANG', 'GEPREK', 'JANJI JIWA', 'KENANGAN', 'CHATIME', 'MIXUE'],
  },
  {
    kategori: 'Transportasi',
    pola: ['GOJEK', 'GOCAR', 'GORIDE', 'GRAB', 'GRABCAR', 'MAXIM', 'BLUEBIRD', 'BLUE BIRD', 'SPBU', 'PERTAMINA', 'SHELL', 'VIVO', 'BP AKR', 'KAI', 'KERETA', 'TRANSJAKARTA', 'MRT', 'LRT', 'DAMRI', 'PARKIR', 'TOL'],
  },
  {
    kategori: 'Tagihan & Utilitas',
    pola: ['PLN', 'PDAM', 'INDIHOME', 'FIRST MEDIA', 'BIZNET', 'MYREPUBLIC', 'IKONNET', 'PGN', 'LISTRIK', 'AIR MINUM'],
  },
  {
    kategori: 'Pulsa & Internet',
    pola: ['TELKOMSEL', 'SIMPATI', 'INDOSAT', 'IM3', 'XL AXIATA', 'AXIS', 'SMARTFREN', 'TRI', 'BY U', 'PULSA'],
  },
  {
    kategori: 'Kesehatan',
    pola: ['APOTEK', 'APOTIK', 'KIMIA FARMA', 'GUARDIAN', 'CENTURY', 'WATSONS', 'KLINIK', 'RUMAH SAKIT', 'RS', 'RSUD', 'PUSKESMAS', 'LABORATORIUM', 'PRODIA', 'HALODOC'],
  },
  {
    kategori: 'Hiburan',
    pola: ['NETFLIX', 'SPOTIFY', 'DISNEY', 'VIU', 'VIDIO', 'IFLIX', 'CGV', 'XXI', 'CINEPOLIS', 'STEAM', 'PLAYSTATION', 'YOUTUBE PREMIUM'],
  },
  {
    kategori: 'Rumah',
    pola: ['ACE HARDWARE', 'INFORMA', 'IKEA', 'TOKO BANGUNAN', 'MITRA10', 'DEPO BANGUNAN'],
  },
  {
    kategori: 'Pendidikan',
    pola: ['GRAMEDIA', 'RUANGGURU', 'ZENIUS', 'BIMBEL', 'SEKOLAH', 'UNIVERSITAS', 'KAMPUS', 'SPP'],
  },
];

/* ── inti ────────────────────────────────────────────────────────────── */

/**
 * Usulan kategori untuk satu merchant.
 *
 * @param riwayat      Pasangan merchant→kategori milik PENGGUNA INI saja.
 * @param cariKategori Menerjemahkan nama kategori sistem menjadi id milik
 *                     pengguna. Mengembalikan `null` bila pengguna sudah
 *                     menghapus kategori itu — dan usulannya lalu dibatalkan,
 *                     bukan dipaksakan ke kategori terdekat.
 */
export function sarankanKategori(
  merchant: string,
  riwayat: RiwayatMerchant[],
  cariKategori: (nama: string) => string | null,
): Saran | null {
  const bersih = rapikan(merchant);
  if (bersih.length === 0) return null;

  const dariRiwayat = sarankanDariRiwayat(bersih, riwayat);
  if (dariRiwayat !== null) return dariRiwayat;

  return sarankanDariKamus(bersih, cariKategori);
}

function sarankanDariRiwayat(bersih: string, riwayat: RiwayatMerchant[]): Saran | null {
  /* Dua lingkaran pencocokan, dan yang lebih sempit dicoba lebih dulu:
     tulisan yang sama persis jauh lebih meyakinkan daripada sekadar berbagi
     kata pertama. */
  const tepat = riwayat.filter((r) => rapikan(r.merchant) === bersih);
  const pilihan = tepat.length > 0 ? tepat : riwayat.filter(
    (r) => kunciCabang(r.merchant) === kunciCabang(bersih) && kunciCabang(bersih).length > 0,
  );

  if (pilihan.length === 0) return null;

  const perKategori = new Map<string, number>();
  for (const r of pilihan) {
    perKategori.set(r.categoryId, (perKategori.get(r.categoryId) ?? 0) + r.jumlah);
  }

  const total = [...perKategori.values()].reduce((s, n) => s + n, 0);
  if (total === 0) return null;

  const urut = [...perKategori.entries()].sort((a, b) => b[1] - a[1]);
  const teratas = urut[0];
  if (teratas === undefined) return null;

  const [categoryId, jumlah] = teratas;
  const bagian = jumlah / total;

  /*
     Keyakinan diturunkan dari KONSISTENSI, bukan dari banyaknya data.

     Sepuluh transaksi yang terbagi lima-lima bukan bukti yang kuat untuk
     salah satunya; ia bukti kuat bahwa merchant itu memang dipakai untuk dua
     hal. Angka 0,8 dan 0,6 dipilih supaya "hampir selalu" dan "biasanya"
     terpisah dari "kadang-kadang", dan yang terakhir tidak pernah menyamar
     sebagai usulan yang percaya diri.
  */
  const keyakinan: Keyakinan = bagian >= 0.8 ? 'tinggi' : bagian >= 0.6 ? 'sedang' : 'rendah';

  const persen = Math.round(bagian * 100);
  return {
    categoryId,
    keyakinan,
    sumber: 'riwayat',
    alasan:
      tepat.length > 0
        ? `Kamu menandai merchant ini begitu pada ${String(jumlah)} dari ${String(total)} transaksi (${String(persen)}%).`
        : `Kamu menandai merchant serupa begitu pada ${String(jumlah)} dari ${String(total)} transaksi (${String(persen)}%).`,
  };
}

/**
 * Cocok per KATA UTUH, bukan per potongan huruf.
 *
 * Ini bukan kerapian melainkan perbaikan cacat yang sungguhan. Versi pertama
 * memakai `String.includes` mentah, dan akibatnya:
 *
 *   "PT INDUSTRI JAYA"  → Pulsa & Internet, karena memuat "TRI"
 *   "MOTORS ABC"        → Kesehatan,        karena memuat "RS"
 *   "HEROIK PERCETAKAN" → Belanja,          karena memuat "HERO"
 *
 * Ketiganya usulan yang percaya diri dan salah — bentuk kegagalan yang paling
 * cepat membuat orang berhenti membaca usulan sama sekali.
 *
 * Ditemukan oleh uji mutasi: melumpuhkan aturan "cocok terpanjang menang"
 * tidak membuat satu uji pun merah, dan menyelidiki sebabnya menunjukkan
 * pencocokannya sendiri yang keliru.
 */
function memuatKata(bersih: string, pola: string): boolean {
  return ` ${bersih} `.includes(` ${pola} `);
}

function sarankanDariKamus(
  bersih: string,
  cariKategori: (nama: string) => string | null,
): Saran | null {
  /*
     Seluruh kamus dikumpulkan LEBIH DULU, lalu yang cocok paling panjang
     menang — lintas kategori, bukan cuma di dalam satu kategori.

     Versi pertama berhenti pada entri pertama yang cocok, jadi urutan daftar
     yang memutuskan ketika dua kategori sama-sama cocok. Urutan daftar adalah
     hal yang paling mudah berubah tanpa sengaja, dan paling tidak pantas
     menentukan jawaban.
  */
  const semua = KAMUS.flatMap(({ pola, kategori }) =>
    pola.filter((p) => memuatKata(bersih, p)).map((p) => ({ pola: p, kategori })),
  ).sort((a, b) => b.pola.length - a.pola.length);

  const teratas = semua[0];
  if (teratas !== undefined) {
    const { pola: cocok, kategori } = teratas;
    const categoryId = cariKategori(kategori);
    /*
       Kategori yang sudah dihapus pengguna TIDAK diganti yang terdekat.

       Usulan yang menunjuk kategori yang sengaja dibuang orang itu lebih
       buruk daripada tidak mengusulkan apa-apa: ia menghidupkan kembali
       sesuatu yang sudah diputuskan tidak dipakai.
    */
    if (categoryId === null) return null;

    return {
      categoryId,
      /* Kamus TIDAK PERNAH 'tinggi'. Ia tebakan berdasar nama, bukan
         berdasar apa yang pernah dilakukan orang ini. */
      keyakinan: 'sedang',
      sumber: 'kamus',
      alasan: `"${cocok}" biasanya masuk ${kategori}. Kamu belum pernah mencatat merchant ini.`,
    };
  }

  return null;
}
