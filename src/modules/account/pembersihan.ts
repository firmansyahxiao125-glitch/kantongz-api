/**
 * Penghapusan SUNGGUHAN — dan mengapa ia mati secara bawaan. F4.
 *
 * ── APA YANG DIHAPUS HAPUS BIASA, DAN APA YANG TIDAK ───────────────────
 *
 * `DELETE /v1/transactions/:id` di aplikasi ini adalah hapus LUNAK: barisnya
 * ditandai `deleted_at` dan berhenti muncul di mana pun. Itu pilihan yang
 * benar untuk pembukuan — baris yang benar-benar hilang tidak dapat diaudit,
 * dan pengguna yang salah tekan tidak kehilangan apa pun.
 *
 * Tetapi "tidak muncul" bukan "tidak ada". Orang yang meminta datanya
 * dihapus — dan di banyak tempat berhak memintanya — sedang meminta yang
 * kedua. Berkas ini yang mengerjakannya.
 *
 * ── MENGAPA MATI SECARA BAWAAN ─────────────────────────────────────────
 *
 * Karena tidak ada tombol batal, dan tidak akan pernah ada.
 *
 * Setiap kemampuan lain di repositori ini dapat diperbaiki sesudah salah:
 * saldo dihitung ulang, kategori diganti, pengingat dikirim lagi. Yang ini
 * tidak. Kegagalan apa pun di sini — bug, salah tafsir tanggal, permintaan
 * yang dikirim dua kali oleh klien yang lambat — menghasilkan data yang tidak
 * dapat dikembalikan oleh siapa pun, termasuk oleh yang menulis kodenya.
 *
 * Jadi ia menuntut TIGA hal sekaligus, dan ketiganya harus benar:
 *
 *   1. server menyalakannya secara eksplisit lewat `PURGE_ENABLED`
 *   2. permintaannya menyertakan `dryRun: false` — bawaannya pratinjau
 *   3. barisnya sudah dihapus-lunak DAN sudah melewati masa tunggu
 *
 * Yang ketiga itu yang paling sering dilupakan rancangan lain: menghapus
 * permanen sesuatu yang baru saja dihapus-lunak meniadakan seluruh gunanya
 * hapus lunak.
 */

/** Masa tunggu terpendek yang masuk akal. Di bawah ini, hapus lunak tidak melindungi apa pun. */
export const MIN_TUNGGU_HARI = 7;

export interface BarisTerhapus {
  id: string;
  /** Kapan ia dihapus-lunak. `null` berarti masih hidup. */
  deletedAt: Date | null;
}

export interface Keputusan {
  /** Id yang benar-benar boleh dihapus permanen. */
  hapus: string[];
  /** Sudah dihapus-lunak tetapi masa tunggunya belum lewat. */
  belumMatang: string[];
}

/**
 * Memutuskan baris mana yang boleh dihapus permanen.
 *
 * Fungsi murni, dan itu bukan kerapian: satu-satunya cara menguji perilaku
 * yang tidak dapat dibatalkan adalah mengujinya tanpa menghapus apa pun.
 *
 * @param sekarang     Disuntikkan. Fungsi yang membaca jamnya sendiri tidak
 *                     dapat diuji pada tepi masa tunggunya.
 * @param tungguHari   Masa tunggu sesudah hapus lunak.
 */
export function putuskanPembersihan(
  baris: BarisTerhapus[],
  sekarang: Date,
  tungguHari: number,
): Keputusan {
  if (tungguHari < MIN_TUNGGU_HARI) {
    /*
       Dijepit, BUKAN dipercaya.

       Ini satu-satunya tempat di repositori ini yang memperbaiki masukan
       alih-alih menolaknya, dan sebabnya arah kesalahannya: menolak berarti
       tidak menghapus apa-apa — akibat yang aman. Menerima nol berarti
       menghapus permanen segala yang baru saja dihapus-lunak, termasuk yang
       ditekan salah semenit lalu.
    */
    tungguHari = MIN_TUNGGU_HARI;
  }

  const batas = new Date(sekarang.getTime() - tungguHari * 86_400_000);

  const hapus: string[] = [];
  const belumMatang: string[] = [];

  for (const b of baris) {
    /* Yang masih hidup tidak pernah tersentuh. Pembersihan bukan penghapusan;
       ia hanya menuntaskan penghapusan yang sudah diminta sebelumnya. */
    if (b.deletedAt === null) continue;

    if (b.deletedAt <= batas) hapus.push(b.id);
    else belumMatang.push(b.id);
  }

  return { hapus, belumMatang };
}
