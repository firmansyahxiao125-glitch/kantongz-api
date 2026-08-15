/**
 * Merencanakan pemulihan dari berkas ekspor.
 *
 * ── MENGAPA PERENCANA TERPISAH DARI PELAKSANA ──────────────────────────
 *
 * Seluruh keputusan sulit pemulihan tidak menyentuh basis data sama sekali:
 * apakah berkasnya sah, versinya dikenali, rujukan antar-tabelnya utuh, dan
 * id mana dipetakan ke id mana. Menaruhnya di dalam transaksi basis data
 * berarti satu-satunya cara mengujinya adalah menjalankan Postgres.
 *
 * Di sini semuanya fungsi murni, jadi kasus yang paling penting — berkas yang
 * rusak, versi masa depan, rujukan menggantung — dapat diuji sebagai
 * aritmetika biasa.
 *
 * ── MENGAPA ID DIPETAKAN ULANG, BUKAN DIPAKAI ULANG ────────────────────
 *
 * Id di dalam berkas ekspor milik akun LAIN. Memakainya kembali menabrak dua
 * hal sekaligus: ia dapat bertabrakan dengan baris yang sudah ada, dan ia
 * membawa jejak akun lama ke dalam akun baru — termasuk ke dalam ekspor
 * berikutnya, selamanya.
 *
 * Jadi setiap baris mendapat id baru, dan seluruh rujukan diterjemahkan lewat
 * peta yang sama. Rujukan yang tidak dapat diterjemahkan DITOLAK, bukan
 * dibiarkan menggantung — transaksi yang menunjuk dompet yang tidak ada
 * adalah baris yang saldonya tidak pernah benar.
 */

/** Versi skema yang dapat dibaca berkas ini. */
export const VERSI_DIDUKUNG = 1;

export type AlasanTolak =
  | 'bukan_objek'
  | 'versi_tidak_didukung'
  | 'bagian_hilang'
  | 'rujukan_menggantung';

export interface Tolakan {
  ok: false;
  alasan: AlasanTolak;
  /** Rincian yang dapat ditunjukkan ke pengguna, bukan jejak tumpukan. */
  detail: string;
}

export interface Rencana {
  ok: true;
  /** id lama -> id baru, per jenis. Dipakai pelaksana dan diuji di sini. */
  peta: {
    wallets: Map<string, string>;
    categories: Map<string, string>;
  };
  jumlah: {
    wallets: number;
    categories: number;
    transactions: number;
    budgets: number;
    goals: number;
    recurring: number;
  };
  /** Baris yang DILEWATI beserta sebabnya. Tidak pernah disembunyikan. */
  dilewati: { jenis: string; sebab: string }[];
}

export type Hasil = Rencana | Tolakan;

interface Baris {
  id?: unknown;
  accountId?: unknown;
  counterAccountId?: unknown;
  categoryId?: unknown;
}

const arr = (x: unknown): Baris[] => (Array.isArray(x) ? (x as Baris[]) : []);
const teks = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 ? x : null);

/**
 * @param buatId  Penghasil id baru. Disuntikkan supaya ujinya deterministik —
 *                fungsi yang memanggil generator acak sendiri tidak dapat
 *                diperiksa hasilnya.
 */
export function rencanakanPemulihan(
  berkas: unknown,
  buatId: (jenis: string, urutan: number) => string,
): Hasil {
  if (typeof berkas !== 'object' || berkas === null || Array.isArray(berkas)) {
    return { ok: false, alasan: 'bukan_objek', detail: 'berkas ekspor harus berupa objek JSON' };
  }

  const b = berkas as Record<string, unknown>;

  /*
     Versi diperiksa LEBIH DULU, sebelum satu bagian pun dibaca.

     Berkas dari versi masa depan mungkin punya bentuk yang sama sekali
     berbeda, dan membacanya dengan asumsi versi lama menghasilkan pemulihan
     yang "berhasil" dengan data yang salah — kegagalan yang jauh lebih buruk
     daripada penolakan.
  */
  const versi = b.schemaVersion;
  if (versi !== VERSI_DIDUKUNG) {
    return {
      ok: false,
      alasan: 'versi_tidak_didukung',
      detail: `versi skema ${String(versi)} tidak dikenali; berkas ini dibuat untuk versi ${String(VERSI_DIDUKUNG)}`,
    };
  }

  for (const bagian of ['wallets', 'transactions']) {
    if (!Array.isArray(b[bagian])) {
      return {
        ok: false,
        alasan: 'bagian_hilang',
        detail: `bagian "${bagian}" tidak ada atau bukan larik`,
      };
    }
  }

  const dompet = arr(b.wallets);
  const kategori = arr(b.categories);
  const transaksi = arr(b.transactions);
  const anggaran = arr(b.budgets);
  const tujuan = arr(b.goals);
  const berulang = arr(b.recurring);

  const petaDompet = new Map<string, string>();
  dompet.forEach((w, i) => {
    const id = teks(w.id);
    if (id !== null) petaDompet.set(id, buatId('wallet', i));
  });

  const petaKategori = new Map<string, string>();
  kategori.forEach((c, i) => {
    const id = teks(c.id);
    if (id !== null) petaKategori.set(id, buatId('category', i));
  });

  const dilewati: { jenis: string; sebab: string }[] = [];

  /*
     Rujukan yang menggantung MENOLAK seluruh berkas, bukan melewati barisnya.

     Ini berbeda dari impor CSV, yang memang melewati baris rusak — di sana
     tiap baris berdiri sendiri, dan lima ratus baris sah tidak boleh gagal
     karena dua yang salah ketik.

     Berkas ekspor bukan itu. Ia SATU pembukuan yang utuh, dan transaksi yang
     dompetnya hilang berarti berkasnya sendiri sudah rusak. Memulihkan
     sebagiannya menghasilkan saldo yang tidak pernah cocok, dan pengguna
     yang tidak akan pernah tahu bagian mana yang hilang.
  */
  for (const t of transaksi) {
    const akun = teks(t.accountId);
    if (akun === null || !petaDompet.has(akun)) {
      return {
        ok: false,
        alasan: 'rujukan_menggantung',
        detail: `transaksi menunjuk dompet "${String(akun)}" yang tidak ada di berkas ini`,
      };
    }
    const lawan = teks(t.counterAccountId);
    if (lawan !== null && !petaDompet.has(lawan)) {
      return {
        ok: false,
        alasan: 'rujukan_menggantung',
        detail: `transfer menunjuk dompet lawan "${lawan}" yang tidak ada di berkas ini`,
      };
    }
  }

  /*
     Kategori SISTEM tidak ikut diekspor, jadi transaksi lama dapat menunjuk
     kategori yang memang tidak ada di berkas. Ini satu-satunya rujukan yang
     boleh gagal tanpa menolak berkasnya: kategorinya dilepas, transaksinya
     tetap masuk, dan itu DICATAT.

     Menolak seluruh berkas karena ini akan membuat setiap ekspor yang memakai
     kategori bawaan — yaitu hampir semuanya — mustahil dipulihkan.
  */
  let kategoriDilepas = 0;
  for (const t of transaksi) {
    const kat = teks(t.categoryId);
    if (kat !== null && !petaKategori.has(kat)) kategoriDilepas += 1;
  }
  if (kategoriDilepas > 0) {
    dilewati.push({
      jenis: 'kategori transaksi',
      sebab: `${String(kategoriDilepas)} transaksi menunjuk kategori sistem yang tidak ikut diekspor; kategorinya dilepas, transaksinya tetap dipulihkan`,
    });
  }

  let anggaranDilewati = 0;
  for (const a of anggaran) {
    const kat = teks(a.categoryId);
    if (kat === null || !petaKategori.has(kat)) anggaranDilewati += 1;
  }
  if (anggaranDilewati > 0) {
    dilewati.push({
      jenis: 'anggaran',
      sebab: `${String(anggaranDilewati)} anggaran menunjuk kategori yang tidak ikut diekspor`,
    });
  }

  return {
    ok: true,
    peta: { wallets: petaDompet, categories: petaKategori },
    jumlah: {
      wallets: petaDompet.size,
      categories: petaKategori.size,
      transactions: transaksi.length,
      budgets: anggaran.length - anggaranDilewati,
      goals: tujuan.length,
      recurring: berulang.length,
    },
    dilewati,
  };
}
