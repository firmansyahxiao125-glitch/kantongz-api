/**
 * Korpus struk sintetis untuk mengukur akurasi pengurai. F5.
 *
 * ── APA YANG DIUKUR, DAN APA YANG TIDAK ────────────────────────────────
 *
 * Yang diukur: PENGURAI — teks menjadi rancangan. Yang TIDAK diukur: mesin
 * OCR itu sendiri, gambar menjadi teks.
 *
 * Batas itu disebut terbuka karena penting. Mengukur OCR ujung-ke-ujung
 * menuntut empat puluh gambar sungguhan, model bahasa berukuran belasan
 * megabita, dan hasil yang bergantung pada kamera, pencahayaan, dan versi
 * Tesseract di mesin yang menjalankannya. Angka yang berubah-ubah karena
 * lingkungan bukan angka.
 *
 * Yang dapat diukur dengan pasti adalah bagian yang benar-benar kita tulis,
 * terhadap masukan yang menyerupai keluaran OCR sungguhan — termasuk
 * kesalahannya.
 *
 * ── MENGAPA DERAUNYA DIBUAT-BUAT, DAN MENGAPA ITU SAH ──────────────────
 *
 * Struk yang bersih tidak menguji apa pun: pengurai apa pun lulus di
 * atasnya. Yang benar-benar sampai ke pengurai adalah teks yang huruf O-nya
 * terbaca nol, angka 1-nya terbaca huruf l, dan spasinya hilang di tempat
 * yang tidak terduga.
 *
 * Kekeliruan yang dipakai di sini bukan karangan: O/0, l/1, S/5, B/8, dan
 * hilangnya spasi adalah kekeliruan OCR yang paling sering terjadi pada
 * teks tercetak, dan struk termal Indonesia memperburuknya karena cetakannya
 * pudar dan kertasnya melengkung.
 */

export interface StrukUji {
  nama: string;
  teks: string;
  benar: {
    total: number;
    /** `null` bila memang tidak dapat ditentukan dari teksnya. */
    merchant: string | null;
  };
}

/* ── derau ────────────────────────────────────────────────────────────── */

/**
 * Pengacak berbenih.
 *
 * Korpus yang berubah tiap jalanan menghasilkan angka akurasi yang
 * berubah-ubah, dan gerbang yang angkanya berubah sendiri akan diabaikan
 * orang dalam sebulan. Benih tetap membuat kegagalan dapat diulang persis.
 */
function acak(benih: number): () => number {
  let s = benih >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KELIRU: Record<string, string> = {
  O: '0',
  o: '0',
  l: '1',
  I: '1',
  S: '5',
  B: '8',
  Z: '2',
};

/**
 * Merusak teks seperti OCR merusaknya — dan TIDAK PERNAH menyentuh angka.
 *
 * Ini pembatasan yang disengaja. Kalau derau boleh mengubah digit, "total
 * 45.000" dapat menjadi "total 46.000" dan ujinya akan menuntut pengurai
 * MENEBAK angka yang sudah hilang — sesuatu yang tidak mungkin dan tidak
 * seharusnya diminta. Yang diuji ketahanan pengurai terhadap teks kotor,
 * bukan kemampuannya meramal.
 */
function rusakkan(teks: string, r: () => number, kekuatan: number): string {
  return teks
    .split('\n')
    .map((baris) => {
      const angkaDilindungi = /\d/.test(baris);
      let keluar = '';
      for (const ch of baris) {
        if (/\d/.test(ch)) {
          keluar += ch;
          continue;
        }
        if (KELIRU[ch] !== undefined && r() < kekuatan && !angkaDilindungi) {
          keluar += KELIRU[ch];
          continue;
        }
        if (ch === ' ' && r() < kekuatan * 0.5) continue;
        keluar += ch;
      }
      return keluar;
    })
    .join('\n');
}

/* ── bentuk struk Indonesia ───────────────────────────────────────────── */

const rp = (n: number): string => n.toLocaleString('id-ID');

interface Bahan {
  merchant: string;
  baris: { nama: string; harga: number }[];
  penandaTotal: string;
  pakaiPajak: boolean;
  /**
   * Menambahkan baris "TOTAL" yang BUKAN totalnya, sebelum total sungguhan.
   *
   * Ini bentuk yang paling sering menjatuhkan pengurai struk, dan korpus
   * tanpanya tidak menguji apa pun yang sulit. Struk Indonesia lazim mencetak
   * "TOTAL" untuk jumlah barang lalu "TOTAL BAYAR" untuk yang benar-benar
   * dibayar — dan pengurai yang mengambil kecocokan PERTAMA akan selalu
   * salah, tanpa satu galat pun.
   *
   * Ditambahkan sesudah bukti merah pertama GAGAL: melumpuhkan prioritas
   * penanda di pengurai tidak membuat gerbang akurasi merah, karena setiap
   * struk hanya punya satu baris berpenanda. Korpus yang tidak dapat
   * mendeteksi pengurai rusak tidak mengukur banyak.
   */
  penandaPengecoh: boolean;
}

function susun(b: Bahan): { teks: string; total: number } {
  const subtotal = b.baris.reduce((s, x) => s + x.harga, 0);
  const pajak = b.pakaiPajak ? Math.round(subtotal * 0.11) : 0;
  const total = subtotal + pajak;

  const baris = [
    b.merchant,
    'Jl. Contoh No. 1, Jakarta',
    '================================',
    ...b.baris.map((x) => `${x.nama.padEnd(20)}${rp(x.harga)}`),
    '--------------------------------',
    `Subtotal            ${rp(subtotal)}`,
    ...(b.pakaiPajak ? [`PPN 11%             ${rp(pajak)}`] : []),
    ...(b.penandaPengecoh ? [`TOTAL               ${rp(subtotal)}`] : []),
    `${b.penandaTotal.padEnd(20)}${rp(total)}`,
    `Tunai               ${rp(Math.ceil(total / 5000) * 5000)}`,
    `Kembali             ${rp(Math.ceil(total / 5000) * 5000 - total)}`,
    '================================',
    'Terima kasih atas kunjungan Anda',
  ];

  return { teks: baris.join('\n'), total };
}

const MERCHANT = [
  'INDOMARET',
  'ALFAMART',
  'Warung Bu Sri',
  'Kopi Kenangan',
  'SUPERINDO',
  'Apotek Sehat',
  'Toko Bangunan Jaya',
  'RM Padang Sederhana',
];

const BARANG = [
  { nama: 'Beras 5kg', harga: 68_000 },
  { nama: 'Minyak Goreng 2L', harga: 34_500 },
  { nama: 'Telur 1kg', harga: 28_000 },
  { nama: 'Kopi Susu', harga: 22_000 },
  { nama: 'Roti Tawar', harga: 16_500 },
  { nama: 'Sabun Mandi', harga: 8_900 },
  { nama: 'Air Mineral 600ml', harga: 4_500 },
  { nama: 'Mie Instan', harga: 3_200 },
  { nama: 'Gula Pasir 1kg', harga: 17_800 },
  { nama: 'Susu UHT 1L', harga: 21_000 },
];

const PENANDA = ['TOTAL', 'Total Bayar', 'GRAND TOTAL', 'Jumlah', 'TOTAL BELANJA'];

/**
 * Empat puluh delapan struk: enam varian derau untuk delapan merchant.
 *
 * Jumlahnya bukan angka bulat yang enak dibaca melainkan hasil perkalian yang
 * memastikan setiap merchant bertemu setiap tingkat derau. Korpus yang
 * merchant-nya menumpuk di satu tingkat derau mengukur derau, bukan pengurai.
 */
export function korpus(): StrukUji[] {
  const hasil: StrukUji[] = [];

  const tingkatDerau = [0, 0, 0.04, 0.08, 0.12, 0.2];

  MERCHANT.forEach((merchant, mi) => {
    tingkatDerau.forEach((derau, di) => {
      const jumlahBarang = 2 + ((mi + di) % 4);
      const barang = Array.from({ length: jumlahBarang }, (_, k) => {
        const item = BARANG[(mi * 3 + di * 2 + k) % BARANG.length];
        return item ?? BARANG[0]!;
      });

      /* Pengecoh hanya dipasang ketika penanda sungguhannya LEBIH SPESIFIK
         daripada "TOTAL" — kalau keduanya sama persis, tidak ada jawaban
         benar yang dapat dituntut dari pengurai mana pun. */
      const penandaTotal = PENANDA[(mi + di) % PENANDA.length] ?? 'TOTAL';
      const bolehPengecoh = penandaTotal !== 'TOTAL' && penandaTotal !== 'Jumlah';

      const { teks, total } = susun({
        merchant,
        baris: barang,
        penandaTotal,
        pakaiPajak: (mi + di) % 3 === 0,
        penandaPengecoh: bolehPengecoh && (mi + di) % 2 === 0,
      });

      hasil.push({
        nama: `${merchant} · derau ${String(Math.round(derau * 100))}%`,
        /* Benih PER STRUK, bukan satu aliran untuk seluruh korpus.

           Satu aliran bersama terlihat lebih sederhana dan ternyata rapuh:
           menambah satu baris ke struk pertama menggeser derau setiap struk
           sesudahnya, dan angka akurasinya berubah tanpa satu baris pengurai
           pun disentuh. Ini benar-benar terjadi — akurasi merchant jatuh dari
           45/48 ke 42/48 hanya karena satu baris pengecoh ditambahkan.

           Benih per struk membuat tiap baris korpus berdiri sendiri: mengubah
           satu struk tidak pernah lagi mengubah struk lain. */
        teks: derau === 0 ? teks : rusakkan(teks, acak(0x4b41 + mi * 101 + di), derau),
        benar: { total, merchant },
      });
    });
  });

  return hasil;
}
