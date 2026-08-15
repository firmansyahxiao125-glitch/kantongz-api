/**
 * Aturan pemecahan satu transaksi ke beberapa kategori. F3.
 *
 * ── `category_id` TIDAK DIBUANG, DAN ITU KEPUTUSAN POKOKNYA ────────────
 *
 * Rancangan yang paling menggoda adalah memindahkan kategori dari transaksi ke
 * baris-baris pecahannya lalu menghapus kolomnya. Ia lebih "bersih" dan ia
 * merusak segalanya yang sudah berdiri di atas kolom itu sekaligus: penyaringan
 * daftar transaksi, seluruh laporan, perhitungan anggaran, berkas ekspor, dan
 * setiap pembukuan yang sudah ditulis pengguna sebelum fitur ini ada.
 *
 * Jadi kolomnya tetap, tetap berisi, dan tetap berarti: ia menjadi kategori
 * UTAMA transaksi — pecahan dengan nominal terbesar. Pembukuan lama terbaca
 * persis seperti sebelumnya, dan kode yang belum tahu apa-apa tentang pecahan
 * tetap menjawab sesuatu yang masuk akal alih-alih `null`.
 *
 * ── SATU RUPIAH TIDAK BOLEH HILANG ─────────────────────────────────────
 *
 * Jumlah seluruh pecahan WAJIB sama persis dengan nominal transaksinya. Bukan
 * "kira-kira", bukan "sisanya masuk Lainnya". Pecahan yang jumlahnya meleset
 * membuat satu transaksi punya dua nilai — satu di barisnya, satu di
 * rinciannya — dan laporan yang membaca keduanya tidak akan pernah cocok.
 *
 * Karena seluruh nominal di aplikasi ini bilangan bulat rupiah, penjumlahannya
 * tepat dan pemeriksaannya boleh keras. Tidak ada toleransi pembulatan, karena
 * tidak ada pembulatan.
 */

import { DomainError } from '../../contracts/domain.js';

/** Serendah-rendahnya dua: satu baris bukan pemecahan, melainkan kategori. */
export const MIN_PECAHAN = 2;

/**
 * Sebanyak-banyaknya dua puluh.
 *
 * Bukan batas teknis melainkan batas kewarasan: struk dengan dua puluh
 * kategori berbeda hampir pasti salah masuk, dan batas yang longgar hanya
 * memindahkan biayanya ke setiap laporan yang kelak membacanya.
 */
export const MAKS_PECAHAN = 20;

export interface BarisPecahan {
  categoryId: string;
  amount: number;
  note?: string | null | undefined;
}

/**
 * Memeriksa satu himpunan pecahan terhadap nominal transaksinya.
 *
 * Melempar `DomainError` pada yang pertama salah, karena seluruh kesalahan di
 * sini membatalkan permintaannya — tidak ada yang dapat "diperbaiki sebagian".
 *
 * @param kategoriSah Kategori yang benar-benar boleh dipakai pengguna ini.
 *                    Disuntikkan sebagai himpunan, bukan dibaca dari basis
 *                    data di sini: aturan pecahan harus dapat diuji tanpa
 *                    Postgres, dan kepemilikan kategori adalah pertanyaan
 *                    yang jawabannya milik lapisan lain.
 */
export function periksaPecahan(
  baris: BarisPecahan[],
  nominalTransaksi: number,
  kategoriSah: ReadonlySet<string>,
): void {
  if (baris.length < MIN_PECAHAN) {
    throw new DomainError(
      'invalid_input',
      `pemecahan menuntut sekurangnya ${String(MIN_PECAHAN)} baris; satu baris berarti cukup pilih kategorinya`,
    );
  }

  if (baris.length > MAKS_PECAHAN) {
    throw new DomainError(
      'invalid_input',
      `pemecahan paling banyak ${String(MAKS_PECAHAN)} baris`,
    );
  }

  const terpakai = new Set<string>();
  let jumlah = 0;

  for (const b of baris) {
    if (!Number.isInteger(b.amount)) {
      throw new DomainError('invalid_input', 'nominal pecahan harus bilangan bulat rupiah');
    }
    if (b.amount <= 0) {
      /* Nol dan negatif dilarang terpisah dari "bukan bilangan bulat" supaya
         pesannya menyebut yang sebenarnya salah. Pecahan bernilai nol adalah
         baris yang tidak mengubah apa pun kecuali membuat laporan memuat
         kategori yang tidak pernah dibelanjakan. */
      throw new DomainError('invalid_input', 'nominal pecahan harus lebih dari nol');
    }

    if (!kategoriSah.has(b.categoryId)) {
      /*
         Pesannya sengaja TIDAK membedakan "kategori tidak ada" dari "kategori
         milik orang lain".

         Membedakannya mengubah pemecahan menjadi alat pengintai: siapa pun
         dapat menebak id dan mengetahui mana yang benar-benar ada di sistem.
      */
      throw new DomainError('not_found', 'kategori tidak ditemukan');
    }

    if (terpakai.has(b.categoryId)) {
      /* Dua baris berkategori sama bukan pemecahan melainkan satu baris yang
         ditulis dua kali — dan ia membuat laporan menampilkan kategori yang
         sama dua kali dalam satu transaksi. */
      throw new DomainError('invalid_input', 'setiap kategori hanya boleh muncul sekali');
    }
    terpakai.add(b.categoryId);

    jumlah += b.amount;
  }

  if (jumlah !== nominalTransaksi) {
    const selisih = jumlah - nominalTransaksi;
    throw new DomainError(
      'invalid_input',
      `jumlah pecahan (${String(jumlah)}) harus sama persis dengan nominal transaksi (${String(nominalTransaksi)}); selisih ${String(selisih)}`,
    );
  }
}

/**
 * Kategori UTAMA sebuah himpunan pecahan: yang nominalnya terbesar.
 *
 * Inilah yang mengisi `transactions.category_id` supaya kolom itu tetap
 * berarti. Seri diputus oleh urutan masukan — bukan oleh id, dan bukan secara
 * acak: pengguna menuliskan barisnya dalam urutan tertentu, dan yang pertama
 * di antara yang sama besar adalah jawaban yang dapat ia ramalkan.
 */
export function kategoriUtama(baris: BarisPecahan[]): string | null {
  let terbaik: BarisPecahan | null = null;
  for (const b of baris) {
    if (terbaik === null || b.amount > terbaik.amount) terbaik = b;
  }
  return terbaik?.categoryId ?? null;
}
