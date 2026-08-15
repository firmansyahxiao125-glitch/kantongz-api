import { and, eq } from 'drizzle-orm';

import type { Database } from '../../platform/db/client.js';
import { walletAccounts, walletShares } from '../../platform/db/ledger.js';

/**
 * SATU penyelesai akses dompet. G3.
 *
 * ── MENGAPA SATU, DAN MENGAPA ITU YANG DITULIS DULUAN ──────────────────
 *
 * Sebelum dompet bersama ada, kepemilikan diperiksa di lima tempat dengan
 * kalimat yang sama: `eq(walletAccounts.userId, userId)`. Lima tempat yang
 * sepakat karena kebetulan menulis hal yang sama, bukan karena ada yang
 * memaksa mereka sepakat.
 *
 * Begitu sebuah dompet dapat diakses orang selain pemiliknya, kelima tempat
 * itu harus berubah bersama-sama — dan yang tertinggal tidak akan gagal
 * dengan berisik. Ia akan diam-diam menolak anggota yang sah, atau, jauh
 * lebih buruk, diam-diam menerima orang yang bukan siapa-siapa.
 *
 * Jadi keputusan izinnya dipindahkan ke SATU fungsi, dan tidak ada jalur lain
 * yang boleh memutuskannya. Aturan itu bukan kesepakatan melainkan gerbang:
 * `akses-dompet.test.ts` memindai repositori dan MERAH bila ada perbandingan
 * `walletAccounts.userId` di luar berkas ini.
 *
 * ── GAGAL-TERTUTUP DI SETIAP CABANG ────────────────────────────────────
 *
 * Setiap jalan keluar dari fungsi ini yang bukan "izin terbukti" adalah
 * `null`. Tidak ada nilai bawaan yang membuka, tidak ada `catch` yang
 * mengembalikan akses baca "karena mungkin dia anggota", dan peran yang tidak
 * dikenali ditolak alih-alih dianggap peran terendah.
 *
 * Yang terakhir itu penting dan mudah salah: peran asing di basis data berarti
 * ada yang menulis nilai yang tidak dikenal kode ini — entah migrasi setengah
 * jalan, entah penyusupan. Keduanya bukan alasan memberi akses baca.
 */

/** `pemilik` tidak pernah tersimpan sebagai baris; ia disimpulkan dari dompetnya. */
export type Peran = 'pemilik' | 'catat' | 'lihat';

/** Peran yang benar-benar dikenali. Apa pun di luar ini ditolak. */
const PERAN_SAH: ReadonlySet<string> = new Set(['catat', 'lihat']);

/** Peran yang boleh MENULIS transaksi pada dompetnya. */
const BOLEH_TULIS: ReadonlySet<Peran> = new Set<Peran>(['pemilik', 'catat']);

/** Hanya pemilik yang boleh mengubah dompetnya sendiri atau membagikannya. */
export function bolehKelola(peran: Peran | null): boolean {
  return peran === 'pemilik';
}

export function bolehTulis(peran: Peran | null): boolean {
  return peran !== null && BOLEH_TULIS.has(peran);
}

export function bolehLihat(peran: Peran | null): boolean {
  /* Setiap peran yang dikenali boleh melihat. Ditulis eksplisit alih-alih
     `peran !== null` supaya penambahan peran kelak harus melewati baris ini. */
  return peran === 'pemilik' || peran === 'catat' || peran === 'lihat';
}

/**
 * Peran seseorang atas sebuah dompet, atau `null` bila tidak punya.
 *
 * Kepemilikan diperiksa LEBIH DULU dan berdiri sendiri: pemilik tidak
 * membutuhkan baris berbagi, dan dompet yang tidak pernah dibagikan tidak
 * membayar satu kueri pun untuk memastikannya.
 */
export async function aksesDompet(
  db: Database,
  userId: string,
  accountId: string,
): Promise<Peran | null> {
  const milik = await db
    .select({ id: walletAccounts.id })
    .from(walletAccounts)
    .where(and(eq(walletAccounts.id, accountId), eq(walletAccounts.userId, userId)))
    .limit(1);

  if (milik.length > 0) return 'pemilik';

  const berbagi = await db
    .select({ role: walletShares.role })
    .from(walletShares)
    .where(and(eq(walletShares.accountId, accountId), eq(walletShares.memberId, userId)))
    .limit(1);

  const peran = berbagi[0]?.role;
  if (peran === undefined) return null;

  /* Peran asing DITOLAK, bukan diturunkan ke `lihat`. Nilai yang tidak dikenal
     kode ini berarti ada yang menulisnya di luar jalur yang diketahui — dan
     itu bukan alasan memberi akses apa pun. */
  if (!PERAN_SAH.has(peran)) return null;

  return peran;
}

/**
 * Seluruh dompet yang boleh DILIHAT seseorang: miliknya sendiri dan yang
 * dibagikan kepadanya.
 *
 * Dikembalikan sebagai daftar id, bukan sebagai potongan `WHERE`. Potongan
 * `WHERE` yang dioper ke lima kueri berbeda adalah lima kesempatan untuk
 * merangkainya dengan `or` alih-alih `and`, dan yang salah merangkai membuka
 * seluruh tabel.
 */
export async function dompetTerlihat(db: Database, userId: string): Promise<string[]> {
  const [milik, dibagikan] = await Promise.all([
    db
      .select({ id: walletAccounts.id })
      .from(walletAccounts)
      .where(eq(walletAccounts.userId, userId)),
    db
      .select({ id: walletShares.accountId })
      .from(walletShares)
      .where(eq(walletShares.memberId, userId)),
  ]);

  return [...new Set([...milik.map((r) => r.id), ...dibagikan.map((r) => r.id)])];
}
