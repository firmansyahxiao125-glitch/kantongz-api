/**
 * Membuang metadata dari gambar struk SEBELUM ia menyentuh penyimpanan.
 *
 * ── MENGAPA INI BUKAN KENYAMANAN, MELAINKAN KEAMANAN ───────────────────
 *
 * Foto struk diambil dengan ponsel, dan ponsel menuliskan jauh lebih banyak
 * ke dalam berkasnya daripada yang terlihat: KOORDINAT GPS, model perangkat,
 * nomor seri lensa, dan cap waktu yang tepat sampai detik.
 *
 * Pada aplikasi keuangan itu berarti riwayat belanja seseorang membawa serta
 * riwayat LOKASI-nya. Satu unduhan ekspor, satu cadangan yang bocor, atau
 * satu berkas yang tidak sengaja dibagikan cukup untuk memetakan ke mana
 * orang itu pergi setiap hari — dari data yang ia kira hanya soal uang.
 *
 * Dibuang di titik MASUK, bukan di titik keluar. Metadata yang sempat
 * tersimpan sudah ada di cadangan, di replika, dan di mana pun basis data itu
 * pernah disalin; membuangnya belakangan hanya membersihkan salinan terakhir.
 *
 * ── DIKERJAKAN SENDIRI, TANPA PUSTAKA ──────────────────────────────────
 *
 * Repositori ini tidak punya pustaka gambar, dan menambahkannya demi satu
 * fungsi berarti mempercayai satu rantai pasok baru untuk sesuatu yang muat
 * dalam dua ratus baris yang dapat dibaca sendiri.
 *
 * Keduanya format berbasis potongan yang terdokumentasi baik, dan yang
 * dikerjakan di sini hanya MEMBUANG potongan — tidak ada piksel yang
 * disentuh, tidak ada penyandian ulang, tidak ada mutu yang hilang.
 */

export type FormatGambar = 'jpeg' | 'png';

export interface HasilBersih {
  data: Buffer;
  format: FormatGambar;
  /** Nama penanda/potongan yang dibuang. Dicatat supaya dapat diperiksa. */
  dibuang: string[];
}

/* ── JPEG ─────────────────────────────────────────────────────────────── */

/**
 * Penanda yang DIBUANG.
 *
 * Seluruh APPn kecuali APP0 (JFIF, yang membawa rasio piksel dan dibutuhkan
 * sebagian dekoder lama), ditambah komentar.
 *
 *   APP1  0xE1  EXIF dan XMP — di sinilah GPS berada
 *   APP2  0xE2  ICC dan FlashPix
 *   APP13 0xED  Photoshop/IPTC — sering memuat nama pembuat
 *   COM   0xFE  komentar bebas
 *
 * Daftarnya berupa "buang semua kecuali", bukan "buang yang ini saja":
 * penanda yang belum ada ketika berkas ini ditulis akan ikut terbuang, dan
 * itu arah kesalahan yang benar untuk data pribadi.
 */
const JPEG_APP0 = 0xe0;
const JPEG_APP15 = 0xef;
const JPEG_COM = 0xfe;
const JPEG_SOS = 0xda;

function namaPenanda(penanda: number): string {
  if (penanda === JPEG_COM) return 'COM';
  if (penanda >= JPEG_APP0 && penanda <= JPEG_APP15) return `APP${String(penanda - JPEG_APP0)}`;
  return `0x${penanda.toString(16)}`;
}

function bersihkanJpeg(buf: Buffer): HasilBersih {
  const keluar: Buffer[] = [Buffer.from([0xff, 0xd8])];
  const dibuang: string[] = [];

  let i = 2;
  while (i < buf.length) {
    /* Penanda selalu 0xFF diikuti byte bukan-0xFF. Byte 0xFF berulang adalah
       isian yang sah dan harus dilewati, bukan diperlakukan sebagai rusak. */
    if (buf[i] !== 0xff) break;
    let j = i + 1;
    while (j < buf.length && buf[j] === 0xff) j += 1;
    const penanda = buf[j];
    if (penanda === undefined) break;

    /* SOS menandai awal data terkompresi. Sesudahnya tidak ada lagi segmen
       bertajuk panjang, jadi sisanya disalin apa adanya sampai akhir. */
    if (penanda === JPEG_SOS) {
      keluar.push(buf.subarray(i));
      break;
    }

    const awalPanjang = j + 1;
    if (awalPanjang + 1 >= buf.length) break;
    const panjang = buf.readUInt16BE(awalPanjang);
    const akhirSegmen = awalPanjang + panjang;
    if (panjang < 2 || akhirSegmen > buf.length) break;

    const buang =
      penanda === JPEG_COM || (penanda > JPEG_APP0 && penanda <= JPEG_APP15);

    if (buang) {
      dibuang.push(namaPenanda(penanda));
    } else {
      keluar.push(buf.subarray(i, akhirSegmen));
    }

    i = akhirSegmen;
  }

  return { data: Buffer.concat(keluar), format: 'jpeg', dibuang };
}

/* ── PNG ──────────────────────────────────────────────────────────────── */

/**
 * Potongan PNG yang DIBUANG.
 *
 * PNG membedakan potongan kritis dan tambahan lewat kapitalisasi huruf
 * pertamanya, tetapi tidak semua yang tambahan boleh dibuang — `gAMA`,
 * `cHRM`, `sRGB`, dan `iCCP` mengubah RUPA gambarnya, dan struk yang warnanya
 * bergeser lebih sulit dibaca OCR maupun mata.
 *
 * Jadi yang dibuang disebut satu per satu: yang memuat teks, waktu, atau
 * EXIF. Daftar tertutup di sini aman karena PNG jarang menambah potongan
 * baru, berbeda dari JPEG yang APP-nya dipakai bebas oleh siapa saja.
 */
const PNG_DIBUANG = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function bersihkanPng(buf: Buffer): HasilBersih {
  const keluar: Buffer[] = [buf.subarray(0, 8)];
  const dibuang: string[] = [];

  let i = 8;
  while (i + 8 <= buf.length) {
    const panjang = buf.readUInt32BE(i);
    const tipe = buf.subarray(i + 4, i + 8).toString('latin1');
    const akhir = i + 12 + panjang;
    if (akhir > buf.length) break;

    if (PNG_DIBUANG.has(tipe)) {
      dibuang.push(tipe);
    } else {
      keluar.push(buf.subarray(i, akhir));
    }

    i = akhir;
    if (tipe === 'IEND') break;
  }

  return { data: Buffer.concat(keluar), format: 'png', dibuang };
}

/* ── pintu masuk ──────────────────────────────────────────────────────── */

const TANDA_JPEG = [0xff, 0xd8, 0xff];
const TANDA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const cocok = (buf: Buffer, tanda: number[]): boolean =>
  buf.length >= tanda.length && tanda.every((b, k) => buf[k] === b);

/**
 * Membuang metadata, atau MENOLAK.
 *
 * Format yang tidak dikenali tidak dilewatkan begitu saja. Melewatkannya
 * berarti berkas yang metadatanya tidak pernah diperiksa tetap tersimpan —
 * dan seluruh gunanya berkas ini hilang pada berkas pertama yang formatnya
 * di luar dugaan.
 */
export function buangMetadata(buf: Buffer): HasilBersih | null {
  if (cocok(buf, TANDA_JPEG)) return bersihkanJpeg(buf);
  if (cocok(buf, TANDA_PNG)) return bersihkanPng(buf);
  return null;
}
