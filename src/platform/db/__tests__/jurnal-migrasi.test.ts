import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Setiap migrasi WAJIB terdaftar di jurnal Drizzle.
 *
 * ── CELAH YANG BENAR-BENAR TERJADI, DAN SEBABNYA ───────────────────────
 *
 * Uji dan produksi menerapkan migrasi dengan cara yang BERBEDA:
 *
 *   harness uji  membaca `drizzle/*.sql` langsung, diurutkan menurut nama
 *   produksi     membaca `drizzle/meta/_journal.json` dan hanya menjalankan
 *                yang terdaftar di sana
 *
 * Akibatnya sebuah berkas migrasi yang ditulis tanpa entri jurnal LULUS
 * seluruh rangkaian uji — 578 di antaranya, termasuk uji yang menyisipkan ke
 * tabel barunya — lalu diam-diam tidak pernah dijalankan di produksi. Yang
 * muncul kemudian bukan galat migrasi melainkan "relation does not exist"
 * pada permintaan pengguna pertama yang menyentuh fitur itu.
 *
 * Itu persis yang terjadi pada F3. Kontainer melaporkan "migrasi diterapkan"
 * dan tabel `transaction_splits` tidak ada.
 *
 * Uji ini menutup celahnya dari sisi yang benar: alih-alih menyeragamkan
 * kedua pemuat — yang menuntut perubahan pada jalur boot produksi demi
 * kenyamanan uji — ia menuntut keduanya SEPAKAT.
 */

const DIR = join(process.cwd(), 'drizzle');

interface Jurnal {
  entries: { idx: number; tag: string }[];
}

describe('jurnal migrasi', () => {
  const berkas = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();

  const jurnal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as Jurnal;
  const terdaftar = jurnal.entries.map((e) => e.tag);

  it('setiap berkas .sql punya entri jurnal', () => {
    const hilang = berkas.filter((b) => !terdaftar.includes(b));
    expect(
      hilang,
      `migrasi ini tidak akan pernah dijalankan di produksi: ${hilang.join(', ')}`,
    ).toEqual([]);
  });

  it('setiap entri jurnal punya berkas .sql', () => {
    /* Arah sebaliknya sama merusaknya: entri tanpa berkas membuat jalur
       migrasi produksi gagal saat boot, bukan diam-diam melewatinya. */
    const hilang = terdaftar.filter((t) => !berkas.includes(t));
    expect(hilang, `entri jurnal tanpa berkas: ${hilang.join(', ')}`).toEqual([]);
  });

  it('urutan jurnal sama dengan urutan nama berkas', () => {
    /* Migrasi dijalankan menurut `idx`, bukan menurut nama. Jurnal yang
       urutannya menyimpang dari penomoran berkas menjalankan SQL dalam
       urutan yang tidak pernah diuji siapa pun. */
    expect(terdaftar).toEqual(berkas);
  });

  it('idx-nya berurutan dari nol tanpa lompatan', () => {
    expect(jurnal.entries.map((e) => e.idx)).toEqual(jurnal.entries.map((_, i) => i));
  });
});
