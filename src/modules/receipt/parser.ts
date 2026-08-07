/**
 * Pengurai struk Indonesia. ROADMAP M6 — Snap-Struk.
 *
 * SELURUHNYA deterministik. Tidak ada model, tidak ada panggilan jaringan, dan
 * karena itu dapat diuji terhadap teks struk sungguhan tanpa satu pun gambar.
 *
 * Pemisahan ini disengaja: OCR hanya mengubah piksel menjadi teks, dan
 * kualitasnya bergantung pada kamera dan pencahayaan. Yang menentukan apakah
 * fiturnya berguna adalah pengurainya — dan pengurai yang hanya dapat diuji
 * lewat gambar tidak akan pernah diuji cukup.
 */

export interface ReceiptDraft {
  /** Nama merchant, bila terbaca. */
  merchant: string | null;
  /** Total dalam rupiah UTUH. `null` bila tidak ditemukan dengan yakin. */
  total: number | null;
  /** Tanggal transaksi, epoch milidetik. `null` bila tidak terbaca. */
  occurredAt: number | null;
  /**
   * Seberapa yakin pengurai terhadap totalnya.
   *
   * Ditampilkan kepada pengguna, dan itulah sebabnya ia ada: struk yang
   * terbaca separuh menghasilkan angka yang terlihat sah, dan pengguna yang
   * tidak diberi tahu keraguannya akan menyimpannya tanpa memeriksa.
   */
  confidence: 'tinggi' | 'sedang' | 'rendah';
  /** Baris yang menghasilkan totalnya, supaya pengguna dapat memeriksanya. */
  totalLine: string | null;
}

/**
 * Kata yang menandai baris total.
 *
 * Urutannya ADALAH prioritasnya. "Total" muncul beberapa kali di satu struk —
 * subtotal, total belanja, total bayar — dan yang benar hampir selalu yang
 * paling akhir dan paling spesifik. `grand total` dan `total bayar` karena itu
 * diperiksa lebih dulu.
 */
const TOTAL_MARKERS: readonly string[] = [
  'grand total',
  'total bayar',
  'total pembayaran',
  'total belanja',
  'jumlah bayar',
  'total harga',
  'total',
  'jumlah',
];

/**
 * Kata yang menandai baris yang BUKAN total, meski memuat kata "total".
 *
 * Tanpa daftar ini, "Subtotal" dan "Total Diskon" akan terbaca sebagai total —
 * dan keduanya muncul di atas total sungguhan, jadi pemindaian dari bawah pun
 * tidak menyelamatkannya.
 */
const NEGATIVE_MARKERS: readonly string[] = [
  'sub total',
  'subtotal',
  'total diskon',
  'total item',
  'total qty',
  'total barang',
  'kembali',
  'kembalian',
  'ppn',
  'pajak',
  'dpp',
];

/** Baris yang menandai bagian pembayaran — apa pun setelahnya bukan total. */
const PAYMENT_MARKERS: readonly string[] = ['tunai', 'cash', 'debit', 'kredit', 'qris', 'bayar'];

/**
 * Mengubah teks nominal Indonesia menjadi bilangan bulat rupiah.
 *
 * Format Indonesia memakai titik sebagai pemisah ribuan dan koma sebagai
 * desimal — kebalikan dari format Inggris. `25.000` adalah dua puluh lima ribu,
 * BUKAN dua puluh lima. Salah membacanya membuat setiap struk tercatat seribu
 * kali lebih kecil.
 */
export function parseRupiah(text: string): number | null {
  const cleaned = text.replace(/rp\.?/gi, '').replace(/\s/g, '').trim();
  if (cleaned.length === 0) return null;

  /* Hanya digit, titik, dan koma. Apa pun selain itu berarti barisnya bukan
     nominal — OCR sering memasukkan huruf ke dalam angka. */
  if (!/^[\d.,]+$/.test(cleaned)) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  /* Yang muncul TERAKHIR adalah pemisah desimalnya — bila ia memisahkan dua
     digit. Struk Indonesia hampir selalu menulis ",00" di akhir. */
  let integerPart = cleaned;

  if (lastComma > lastDot && cleaned.length - lastComma === 3) {
    integerPart = cleaned.slice(0, lastComma);
  } else if (lastDot > lastComma && cleaned.length - lastDot === 3) {
    /* Titik yang memisahkan tepat dua digit di akhir BISA desimal, tetapi di
       struk Indonesia jauh lebih sering ribuan: "25.00" adalah anomali,
       "25.000" adalah normal. Tiga digit setelah titik berarti ribuan. */
    integerPart = cleaned.slice(0, lastDot);
  }

  const digits = integerPart.replace(/[.,]/g, '');
  if (digits.length === 0) return null;

  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Nominal terakhir pada sebuah baris — angka total selalu di ujung kanan. */
function amountOnLine(line: string): number | null {
  const matches = [...line.matchAll(/(?:rp\.?\s*)?([\d][\d.,]*)/gi)];
  if (matches.length === 0) return null;

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const value = parseRupiah(matches[i]?.[1] ?? '');
    if (value !== null) return value;
  }
  return null;
}

/**
 * Tanggal Indonesia dalam berbagai bentuk.
 *
 * `dd/mm/yy`, `dd-mm-yyyy`, dan `dd mmm yyyy`. Yang TIDAK didukung adalah
 * `mm/dd`: struk Indonesia tidak memakainya, dan menebak antara keduanya akan
 * salah pada dua belas hari pertama setiap bulan tanpa cara mengetahuinya.
 */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, mei: 4, may: 4, jun: 5,
  jul: 6, agu: 7, aug: 7, sep: 8, okt: 9, oct: 9, nov: 10, des: 11, dec: 11,
};

export function parseTanggal(text: string, now = new Date()): number | null {
  const numeric = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/.exec(text);

  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]) - 1;
    const rawYear = Number(numeric[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;

    if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
      /* Tengah hari, bukan tengah malam: tanggal 1 yang disimpan sebagai 00:00
         lokal jatuh ke bulan sebelumnya begitu ada pergeseran zona. */
      const parsed = new Date(year, month, day, 12);
      if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() === year) {
        return parsed.getTime();
      }
    }
  }

  const named = /\b(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{4})\b/i.exec(text);
  if (named) {
    const month = MONTHS[(named[2] ?? '').slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      const parsed = new Date(Number(named[3]), month, Number(named[1]), 12);
      if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
    }
  }

  /* Struk tanpa tanggal terbaca dicatat pada hari ini — itu jauh lebih sering
     benar daripada salah, dan pengguna dapat mengubahnya di formulir. */
  return now.getTime();
}

/** Baris yang jelas bukan nama merchant. */
const NOT_MERCHANT = /^(jl\.?|jalan|telp|no\.?|npwp|kasir|struk|tanggal|tgl|waktu|\d)/i;

/**
 * Nama merchant.
 *
 * Diambil dari baris-baris teratas: hampir setiap struk Indonesia mencetak nama
 * tokonya paling atas, di atas alamat dan nomor telepon. Yang dilewati adalah
 * baris yang jelas alamat atau nomor.
 */
function findMerchant(lines: readonly string[]): string | null {
  for (const line of lines.slice(0, 6)) {
    const trimmed = line.trim();
    if (trimmed.length < 3 || trimmed.length > 40) continue;
    if (NOT_MERCHANT.test(trimmed)) continue;
    /* Baris yang seluruhnya angka dan tanda baca bukan nama. */
    if (!/[a-z]{3}/i.test(trimmed)) continue;

    return trimmed.replace(/\s+/g, ' ');
  }
  return null;
}

/**
 * Mengurai teks struk hasil OCR menjadi rancangan transaksi.
 *
 * Mengembalikan rancangan, BUKAN transaksi. Pengguna selalu mengonfirmasi
 * sebelum apa pun tersimpan — struk yang terbaca separuh menghasilkan angka
 * yang terlihat sah, dan pencatatan otomatis tanpa konfirmasi akan mengisi
 * pembukuan dengan angka yang tidak pernah diperiksa siapa pun.
 */
export function parseReceipt(text: string, now = new Date()): ReceiptDraft {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const lower = lines.map((line) => line.toLowerCase());

  let total: number | null = null;
  let totalLine: string | null = null;
  let markerRank = TOTAL_MARKERS.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lower[i] ?? '';

    if (NEGATIVE_MARKERS.some((marker) => line.includes(marker))) continue;

    /* Baris pembayaran hanya dilewati bila ia TIDAK juga membawa penanda total
       — "total bayar" memuat "bayar", dan melewatinya akan membuang justru
       baris yang paling benar. */
    const isTotalMarker = TOTAL_MARKERS.findIndex((marker) => line.includes(marker));
    if (isTotalMarker === -1) continue;
    if (
      PAYMENT_MARKERS.some((marker) => line.includes(marker)) &&
      !line.includes('total') &&
      !line.includes('jumlah')
    ) {
      continue;
    }

    const amount = amountOnLine(lines[i] ?? '');
    if (amount === null) continue;

    /* Penanda yang lebih spesifik menang. Pada kekhususan yang sama, yang
       terakhir menang — total sungguhan hampir selalu di bawah. */
    if (isTotalMarker <= markerRank) {
      markerRank = isTotalMarker;
      total = amount;
      totalLine = lines[i] ?? null;
    }
  }

  const merchant = findMerchant(lines);
  const occurredAt = parseTanggal(text, now);

  /*
   * Keyakinan dinyatakan terbuka. Struk yang terbaca separuh menghasilkan angka
   * yang terlihat sah, dan pengguna yang tidak diberi tahu keraguannya akan
   * menyimpannya tanpa memeriksa.
   */
  const confidence: ReceiptDraft['confidence'] =
    total === null
      ? 'rendah'
      : markerRank <= 2 && merchant !== null
        ? 'tinggi'
        : 'sedang';

  return { merchant, total, occurredAt, confidence, totalLine };
}
