import type { BudgetRow } from '../../platform/db/ledger.js';
import { DEFAULT_TIMEZONE, previousPeriods, toDateString } from './periods.js';
import * as repo from './repository.js';
import type { LedgerDeps } from './service.js';

/**
 * Sisa anggaran yang terbawa antar periode.
 *
 * ── AMPLOP, BUKAN JATAH YANG HANGUS ─────────────────────────────────────
 *
 * Anggaran yang hangus tiap bulan menghukum orang yang berhemat: bulan yang
 * dilewati dengan Rp 300.000 tersisa tidak memberi apa pun, sementara bulan
 * berikutnya tetap dimulai dari angka yang sama. Yang terjadi kemudian selalu
 * sama — belanja terburu-buru di akhir bulan supaya "tidak terbuang".
 *
 * Dengan bawaan, sisa itu ikut. Dan kelebihannya juga ikut: bulan yang jebol
 * Rp 200.000 memulai bulan berikutnya dengan amplop yang lebih tipis. Bawaan
 * yang hanya positif adalah anggaran yang tidak pernah menagih apa pun.
 *
 * ── TIDAK DISIMPAN DI MANA PUN ──────────────────────────────────────────
 *
 * Sisanya dihitung dari transaksi setiap kali diminta. Kolom "sisa" adalah
 * angka yang harus selalu sepakat dengan buku besar dan tidak ada yang
 * menegakkan kesepakatannya: satu transaksi lama yang diubah atau dihapus
 * membuatnya salah selamanya, diam-diam. Alasan yang sama dengan saldo
 * dompet, yang juga dihitung dan tidak disimpan.
 */

/**
 * Sejauh mana ke belakang bawaan ditelusuri.
 *
 * Dua belas periode: setahun untuk anggaran bulanan. Lebih jauh dari itu
 * berarti membaca transaksi bertahun-tahun untuk memuat satu dasbor, dan
 * amplop yang menampung sisa tiga tahun bukan lagi anggaran.
 */
export const MAX_ROLLOVER_PERIODS = 12;

/**
 * Bawaan dari sederet periode, terlama dulu.
 *
 * BERANTAI, bukan penjumlahan sisa masing-masing: amplop periode ini adalah
 * jatah ditambah bawaan, dan yang tersisa DARINYA menjadi bawaan berikutnya.
 * Menjumlahkan `(jatah − terpakai)` per periode secara terpisah menghasilkan
 * angka yang sama hanya ketika tidak ada periode yang jebol.
 */
export function carryOverOf(amount: number, spentPerPeriod: number[]): number {
  let carry = 0;
  for (const spent of spentPerPeriod) carry = amount + carry - spent;
  return carry;
}

/** Batas yang benar-benar berlaku. Tidak pernah negatif. */
export function limitOf(amount: number, carryOver: number): number {
  return Math.max(0, amount + carryOver);
}

/**
 * Bawaan untuk setiap anggaran yang menyalakannya, dalam SATU kueri.
 *
 * Anggaran yang tidak menyalakan bawaan tidak ikut dihitung sama sekali —
 * fitur yang dimatikan tidak boleh membebani permintaan siapa pun.
 */
export async function carryOverFor(
  deps: LedgerDeps,
  userId: string,
  rows: BudgetRow[],
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): Promise<Map<string, number>> {
  const hasil = new Map<string, number>();
  const aktif = rows.filter((r) => r.rollover);
  if (aktif.length === 0) return hasil;

  /* Rentang per jenis periode dihitung sekali; beberapa anggaran bulanan
     berbagi dua belas rentang yang sama persis. */
  const rentang = new Map<BudgetRow['period'], { from: Date; to: Date }[]>();
  for (const row of aktif) {
    if (!rentang.has(row.period)) {
      rentang.set(row.period, previousPeriods(row.period, now, MAX_ROLLOVER_PERIODS, timeZone));
    }
  }

  /* Satu kueri untuk rentang TERLUAS di antara semuanya, dipecah menjadi hari
     lokal. Satu kueri per periode per anggaran berarti seratus kueri untuk
     memuat satu dasbor. */
  let paling: Date | null = null;
  for (const daftar of rentang.values()) {
    const awal = daftar[0]?.from;
    if (awal && (!paling || awal < paling)) paling = awal;
  }
  if (!paling) return hasil;

  const harian = await repo.spentPerCategoryPerDay(deps.db, userId, paling, now, timeZone);

  /* Dikelompokkan per kategori lebih dulu supaya penjumlahan per periode di
     bawah tidak menyapu seluruh larik untuk setiap anggaran. */
  const perKategori = new Map<string, { day: string; total: number }[]>();
  for (const baris of harian) {
    const daftar = perKategori.get(baris.categoryId);
    if (daftar) daftar.push(baris);
    else perKategori.set(baris.categoryId, [baris]);
  }

  for (const row of aktif) {
    const hari = perKategori.get(row.categoryId) ?? [];
    const terpakai: number[] = [];

    for (const r of rentang.get(row.period) ?? []) {
      const dari = toDateString(r.from, timeZone);
      const sampai = toDateString(r.to, timeZone);

      /* Periode yang MENDAHULUI berdirinya anggaran dilewati: pengeluaran
         sebelum anggaran ada bukan pelanggaran anggaran itu, dan
         menghitungnya akan membuat anggaran baru lahir dengan utang. */
      if (dari < row.startsOn) continue;

      let jumlah = 0;
      for (const h of hari) if (h.day >= dari && h.day <= sampai) jumlah += h.total;
      terpakai.push(jumlah);
    }

    hasil.set(row.id, carryOverOf(row.amount, terpakai));
  }

  return hasil;
}
