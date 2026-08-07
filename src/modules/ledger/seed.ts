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

const SYSTEM_CATEGORIES: Seed[] = [
  { name: 'Gaji', kind: 'income', icon: 'wallet', color: '#22c55e' },
  { name: 'Usaha', kind: 'income', icon: 'store', color: '#10b981' },
  { name: 'Investasi', kind: 'income', icon: 'trending-up', color: '#14b8a6' },
  { name: 'Hadiah', kind: 'income', icon: 'gift', color: '#84cc16' },
  { name: 'Lainnya', kind: 'income', icon: 'plus-circle', color: '#65a30d' },

  { name: 'Makan & Minum', kind: 'expense', icon: 'utensils', color: '#f97316' },
  { name: 'Belanja', kind: 'expense', icon: 'shopping-bag', color: '#ec4899' },
  { name: 'Transportasi', kind: 'expense', icon: 'car', color: '#3b82f6' },
  { name: 'Tagihan & Utilitas', kind: 'expense', icon: 'receipt', color: '#8b5cf6' },
  { name: 'Rumah', kind: 'expense', icon: 'home', color: '#a855f7' },
  { name: 'Kesehatan', kind: 'expense', icon: 'heart-pulse', color: '#ef4444' },
  { name: 'Pendidikan', kind: 'expense', icon: 'graduation-cap', color: '#0ea5e9' },
  { name: 'Hiburan', kind: 'expense', icon: 'clapperboard', color: '#d946ef' },
  { name: 'Pulsa & Internet', kind: 'expense', icon: 'smartphone', color: '#06b6d4' },
  { name: 'Zakat & Donasi', kind: 'expense', icon: 'hand-heart', color: '#eab308' },
  { name: 'Asuransi', kind: 'expense', icon: 'shield', color: '#6366f1' },
  { name: 'Pajak', kind: 'expense', icon: 'landmark', color: '#64748b' },
  { name: 'Lainnya', kind: 'expense', icon: 'circle-dashed', color: '#71717a' },
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
