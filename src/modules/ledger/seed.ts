import { isNull, sql } from 'drizzle-orm';

import type { Database } from '../../platform/db/client.js';
import { categories } from '../../platform/db/ledger.js';
import { newId } from '../audit/index.js';

/**
 * Kategori bawaan sistem.
 *
 * Dimiliki bersama (`user_id` NULL), bukan disalin ke setiap pendaftaran. Dua
 * puluh baris per pengguna berarti dua puluh baris yang tidak akan pernah bisa
 * diperbaiki serentak ketika salah satunya salah nama.
 *
 * Daftarnya dipilih untuk pola belanja Indonesia dan bukan diterjemahkan dari
 * daftar Amerika: "Transportasi" mencakup ojek daring, dan "Zakat & Donasi"
 * adalah pos anggaran nyata bagi sebagian besar pengguna.
 */

interface Seed {
  name: string;
  kind: 'income' | 'expense';
  icon: string;
  color: string;
}

/**
 * ── WARNA KATEGORI ─────────────────────────────────────────────────────
 *
 * Sebelumnya seluruh delapan belas warna adalah palet BAWAAN Tailwind —
 * `#3b82f6`, `#f97316`, `#d946ef`, dan seterusnya. Yang pertama itu persis
 * warna yang `kantongz-web/src/app/globals.css` nyatakan sudah dibuang dari
 * produk: "palet bawaan kerangka kerja adalah hal pertama yang terbaca
 * sebagai templat". Sistem desainnya diperbaiki di CSS; warna kategori tidak
 * pernah ikut, dan setiap pengguna baru tetap menerimanya.
 *
 * ── MENGAPA KATEGORI PUNYA PALETNYA SENDIRI ────────────────────────────
 *
 * DESIGN.md menyisakan sedikit sekali warna, dan seluruhnya sudah punya arti:
 * KUNINGAN hanya uang, HOLOGRAM hanya informasi dan maksimal satu per layar,
 * dan hijau/merah/kuning adalah sinyal semantik. Memakai salah satunya untuk
 * kategori akan melemahkan isyarat yang justru paling ketat dijaga dokumen
 * itu. Kategori karena itu memakai keluarga terpisah yang sengaja TIDAK
 * menyerempet kelimanya.
 *
 * ── MENGAPA NILAINYA TERLIHAT GANJIL ───────────────────────────────────
 *
 * Karena dihitung, bukan dipilih dengan mata. Setiap warna wajib mencapai
 * 3:1 (WCAG 1.4.11, elemen non-teks) pada KEEMPAT permukaan tempat ia
 * benar-benar digambar — `surface` dan `surface-3`, di tema gelap DAN terang.
 * Syarat itu mengunci luminansi relatifnya ke jendela sempit:
 *
 *   vs #1e242f  (L=0,0166) : (L+0,05)/0,0666 >= 3  ->  L >= 0,150
 *   vs #ffffff  (L=1,0)    : 1,05/(L+0,05)   >= 3  ->  L <= 0,300
 *
 * Rona dipilih lebih dulu demi identitas kategori, lalu terangnya dicari
 * sampai luminansinya mendarat di tengah jendela itu. Hasilnya: minimum 3,27
 * di seluruh delapan belas warna dan keempat permukaan.
 *
 * Yang lama, sebagai perbandingan, jatuh serendah 1,19 di tema gelap dan
 * 1,00 di tema terang — praktis tidak terlihat.
 *
 * Mengubah salah satu nilai di bawah menuntut pengukuran ulang, bukan selera.
 */
const SYSTEM_CATEGORIES: Seed[] = [
  { name: 'Gaji', kind: 'income', icon: 'wallet', color: '#3a8f6b' },
  { name: 'Usaha', kind: 'income', icon: 'store', color: '#3f8c87' },
  { name: 'Investasi', kind: 'income', icon: 'trending-up', color: '#4b85af' },
  { name: 'Hadiah', kind: 'income', icon: 'gift', color: '#628b44' },
  { name: 'Lainnya', kind: 'income', icon: 'plus-circle', color: '#5c8a68' },

  { name: 'Makan & Minum', kind: 'expense', icon: 'utensils', color: '#bb6a51' },
  { name: 'Belanja', kind: 'expense', icon: 'shopping-bag', color: '#b76691' },
  { name: 'Transportasi', kind: 'expense', icon: 'car', color: '#5881bb' },
  { name: 'Tagihan & Utilitas', kind: 'expense', icon: 'receipt', color: '#8078b6' },
  { name: 'Rumah', kind: 'expense', icon: 'home', color: '#9074b1' },
  { name: 'Kesehatan', kind: 'expense', icon: 'heart-pulse', color: '#bd6574' },
  { name: 'Pendidikan', kind: 'expense', icon: 'graduation-cap', color: '#3d8a9d' },
  { name: 'Hiburan', kind: 'expense', icon: 'clapperboard', color: '#a869b1' },
  { name: 'Pulsa & Internet', kind: 'expense', icon: 'smartphone', color: '#3f8b93' },
  { name: 'Zakat & Donasi', kind: 'expense', icon: 'hand-heart', color: '#7a8642' },
  { name: 'Asuransi', kind: 'expense', icon: 'shield', color: '#727eac' },
  { name: 'Pajak', kind: 'expense', icon: 'landmark', color: '#788091' },
  { name: 'Lainnya', kind: 'expense', icon: 'circle-dashed', color: '#7f7f8b' },
];

/**
 * Menanam kategori bawaan bila belum ada.
 *
 * `onConflictDoNothing` terhadap indeks unik parsial `categories_system_name`:
 * dua instans yang boot bersamaan akan menjalankan ini bersamaan, dan yang
 * kalah balapan tidak boleh menjatuhkan proses.
 */
export async function seedSystemCategories(db: Database): Promise<number> {
  const existing = await db
    .select({ count: sql<string>`count(*)` })
    .from(categories)
    .where(isNull(categories.userId));

  if (Number(existing[0]?.count ?? 0) >= SYSTEM_CATEGORIES.length) return 0;

  const rows = SYSTEM_CATEGORIES.map((seed, index) => ({
    id: newId('cat'),
    userId: null,
    sortOrder: index,
    ...seed,
  }));

  const inserted = await db
    .insert(categories)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: categories.id });

  return inserted.length;
}
