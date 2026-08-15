import { localNoon, toDateString, DEFAULT_TIMEZONE } from '../ledger/periods.js';

/**
 * Merencanakan pengingat jatuh tempo. G1.
 *
 * ── MENGAPA PERENCANA MURNI, TERPISAH DARI PENGIRIM ────────────────────
 *
 * Seluruh keputusan sulit pengingat tidak menyentuh basis data maupun email:
 * aturan mana yang sudah cukup dekat, mana yang sudah lewat, mana yang
 * berakhir, dan — yang paling menentukan — kunci apa yang membuat pengingat
 * yang sama tidak pernah terkirim dua kali.
 *
 * Ditaruh di dalam pekerja, satu-satunya cara mengujinya adalah menjalankan
 * Postgres dan sebuah server SMTP lalu menunggu. Di sini semuanya aritmetika
 * tanggal, jadi kasus yang paling penting dapat diperiksa sebagai fungsi
 * biasa.
 *
 * ── KUNCINYA TANGGAL JATUH TEMPO, BUKAN TANGGAL KIRIM ──────────────────
 *
 * Ini keputusan yang menentukan seluruh perilaku fitur, dan salahnya tidak
 * kelihatan sampai email sudah terkirim ke orang.
 *
 * Kunci `pengingat:{aturan}:{TANGGAL-KIRIM}` terlihat benar dan mengirim satu
 * email SETIAP HARI selama aturannya masih di dalam ufuk — tiga hari ufuk
 * berarti tiga email untuk satu tagihan yang sama. Idempoten terhadap
 * pengulangan dalam satu hari, dan sama sekali tidak idempoten terhadap yang
 * sebenarnya diminta orang: satu tagihan, satu pemberitahuan.
 *
 * Kunci `pengingat:{aturan}:{TANGGAL-JATUH-TEMPO}` tidak berubah selama
 * kejadian yang diingatkan belum berganti. Pekerja boleh berjalan tiap menit,
 * dua instans boleh berjalan bersamaan, dan penanda "sudah dikirim" boleh
 * gagal ditulis — yang keluar tetap satu email untuk satu kejadian, selamanya.
 *
 * ── MENGAPA SATU EMAIL PER KEJADIAN, BUKAN SATU RINGKASAN PER HARI ─────
 *
 * Ringkasan harian ("3 tagihan minggu ini") terasa lebih sopan, dan saya tidak
 * memilihnya. Isi ringkasan berubah setiap kali ada aturan yang masuk atau
 * keluar ufuk, jadi kuncinya ikut berubah, jadi tagihan yang sama muncul lagi
 * di ringkasan besok — dan jaminannya melemah dari "tepat sekali per kejadian"
 * menjadi "paling banyak sekali per hari". Yang diminta di sini yang pertama.
 *
 * Harganya jujur: pengguna dengan enam langganan yang jatuh tempo pada pekan
 * yang sama menerima enam email, tersebar menurut tanggalnya masing-masing.
 * Dengan ufuk tiga hari itu jarang lebih dari satu atau dua per hari.
 */

/** Berapa hari sebelum jatuh tempo pengingat dikirim. */
export const UFUK_HARI = 3;

/** Sepotong aturan berulang — hanya yang benar-benar dipakai perencana. */
export interface AturanJatuhTempo {
  id: string;
  userId: string;
  email: string;
  nama: string | null;
  judul: string;
  jumlah: number;
  /** `YYYY-MM-DD`, kejadian berikutnya yang belum dicatat. */
  nextRunOn: string;
  /** `YYYY-MM-DD` atau null bila aturannya tak berhingga. */
  endsOn: string | null;
  pausedAt: Date | null;
}

export interface Pengingat {
  ruleId: string;
  userId: string;
  email: string;
  nama: string | null;
  judul: string;
  jumlah: number;
  jatuhTempo: string;
  /** 0 berarti hari ini. Tidak pernah negatif — lihat penyaringan di bawah. */
  sisaHari: number;
  kunci: string;
}

/**
 * Kunci idempotensi satu pengingat.
 *
 * Diekspor karena uji dan pekerja HARUS memakai kunci yang sama persis;
 * dua tempat yang menyusun kunci sendiri-sendiri akan berbeda suatu hari,
 * dan hari itu email ganda mulai keluar tanpa satu galat pun.
 */
export function kunciPengingat(ruleId: string, jatuhTempo: string): string {
  return `pengingat:${ruleId}:${jatuhTempo}`;
}

/**
 * Selisih hari antara dua tanggal lokal.
 *
 * Dihitung lewat tengah hari, bukan tengah malam. Tengah malam berada tepat di
 * batas hari: pergeseran satu jam apa pun — pembulatan, zona waktu server,
 * peralihan musim di zona lain yang memakai fungsi yang sama — memindahkannya
 * ke hari sebelumnya, dan "jatuh tempo besok" menjadi "jatuh tempo hari ini".
 * Tengah hari berjarak dua belas jam dari kedua batas.
 */
function selisihHari(dari: string, ke: string): number {
  const ms = localNoon(ke).getTime() - localNoon(dari).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * @param aturan  Aturan yang sudah disaring KASAR oleh basis data. Perencana
 *                menyaring ulang: kueri yang optimal dan aturan yang benar
 *                jarang sama persis, dan yang dipercaya di sini yang kedua.
 * @param sekarang Waktu acuan. Disuntikkan supaya ujinya deterministik.
 */
export function rencanakanPengingat(
  aturan: AturanJatuhTempo[],
  sekarang: Date,
  ufuk: number = UFUK_HARI,
  timeZone: string = DEFAULT_TIMEZONE,
): Pengingat[] {
  const hariIni = toDateString(sekarang, timeZone);
  const hasil: Pengingat[] = [];

  for (const a of aturan) {
    /* Aturan yang dijeda tidak mengingatkan apa-apa: tidak ada yang akan
       terjadi pada tanggal itu. */
    if (a.pausedAt !== null) continue;

    /*
       Aturan yang sudah berakhir juga tidak.

       `next_run_on` TIDAK dikosongkan ketika sebuah aturan melewati
       `ends_on` — ia tetap menyimpan tanggal kejadian berikutnya yang tidak
       akan pernah terjadi. Pengingat yang membaca kolom itu tanpa memeriksa
       `ends_on` akan mengabarkan tagihan yang sudah selesai.
    */
    if (a.endsOn !== null && a.nextRunOn > a.endsOn) continue;

    const sisaHari = selisihHari(hariIni, a.nextRunOn);

    /*
       Yang sudah LEWAT tidak diingatkan, dan sebabnya bukan kesopanan.

       `next_run_on` di masa lalu berarti pekerja berulanglah yang tertinggal,
       bukan penggunanya yang lupa. Email "tagihanmu jatuh tempo dua hari lalu"
       mengabarkan keterlambatan kami sebagai kelalaian dia, dan tidak ada
       tindakan yang dapat diambilnya. Kejadiannya akan tercatat sendiri begitu
       putaran berikutnya berjalan.
    */
    if (sisaHari < 0) continue;
    if (sisaHari > ufuk) continue;

    hasil.push({
      ruleId: a.id,
      userId: a.userId,
      email: a.email,
      nama: a.nama,
      judul: a.judul,
      jumlah: a.jumlah,
      jatuhTempo: a.nextRunOn,
      sisaHari,
      kunci: kunciPengingat(a.id, a.nextRunOn),
    });
  }

  /* Diurutkan menurut jatuh tempo: yang paling mendesak lebih dulu, supaya
     satu putaran yang terpotong di tengah tetap mengirim yang paling penting. */
  return hasil.sort((x, y) => x.jatuhTempo.localeCompare(y.jatuhTempo));
}
