import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bolehKelola, bolehLihat, bolehTulis, type Peran } from '../akses-dompet.js';

/**
 * G3 — SATU penyelesai akses dompet, ditegakkan secara mekanis.
 *
 * Bagian pertama menguji aturannya. Bagian kedua menguji sesuatu yang tidak
 * dapat diuji dengan memanggil fungsi: bahwa tidak ada JALUR LAIN yang
 * memutuskan izin dompet.
 */

const SEMUA: (Peran | null)[] = ['pemilik', 'catat', 'lihat', null];

describe('G3 · aturan peran', () => {
  it('hanya pemilik yang boleh mengelola', () => {
    expect(SEMUA.filter(bolehKelola)).toEqual(['pemilik']);
  });

  it('pemilik dan catat boleh menulis; lihat tidak', () => {
    expect(SEMUA.filter(bolehTulis)).toEqual(['pemilik', 'catat']);
  });

  it('setiap peran yang dikenali boleh melihat', () => {
    expect(SEMUA.filter(bolehLihat)).toEqual(['pemilik', 'catat', 'lihat']);
  });

  it('null ditolak oleh KETIGANYA — gagal-tertutup', () => {
    /* Satu-satunya nilai yang tidak boleh membuka apa pun. Fungsi izin yang
       menjawab `true` untuk `null` adalah pintu yang terbuka bagi siapa saja
       yang tidak punya hubungan apa pun dengan dompetnya. */
    expect(bolehKelola(null)).toBe(false);
    expect(bolehTulis(null)).toBe(false);
    expect(bolehLihat(null)).toBe(false);
  });

  it('peran asing ditolak, bukan diturunkan', () => {
    /* Nilai yang tidak dikenal kode ini berarti ada yang menulisnya di luar
       jalur yang diketahui — migrasi setengah jalan atau penyusupan. Keduanya
       bukan alasan memberi akses baca. */
    const asing = 'admin' as unknown as Peran;

    expect(bolehKelola(asing)).toBe(false);
    expect(bolehTulis(asing)).toBe(false);
    expect(bolehLihat(asing)).toBe(false);
  });
});

/* ── gerbang: tidak ada penyelesai kedua ─────────────────────────────── */

const SRC = join(process.cwd(), 'src');

/** Satu-satunya berkas yang boleh memutuskan izin dompet. */
const PENYELESAI = join('src', 'modules', 'ledger', 'akses-dompet.ts').replace(/\\/g, '/');

/**
 * Berkas yang dikecualikan, masing-masing dengan sebabnya.
 *
 * Daftar ini sengaja pendek dan setiap barisnya harus dapat dibela. Gerbang
 * yang pengecualiannya bertambah tiap bulan berhenti menjaga apa pun.
 */
const DIKECUALIKAN = new Set([
  /* Definisi tabelnya sendiri — ia MENDEKLARASIKAN kolomnya, tidak memutuskan
     apa pun dengannya. */
  join('src', 'platform', 'db', 'ledger.ts').replace(/\\/g, '/'),

  /* Administrasi keanggotaan: menambah, membaca, dan menghapus baris berbagi —
     seluruhnya SESUDAH pemanggilnya membuktikan dirinya pemilik lewat
     penyelesai. Ia tidak memutuskan apa pun.

     Ia sengaja dipisahkan ke berkas kecil yang seluruh isinya dapat dibaca
     sekali duduk, alih-alih dititipkan ke `repository.ts` yang seribu baris.
     Pengecualian pada berkas raksasa akan membebaskan justru tempat yang
     paling wajar bagi penyelesai kedua untuk tumbuh diam-diam. */
  join('src', 'modules', 'ledger', 'berbagi-dompet.ts').replace(/\\/g, '/'),
]);

function berkasTs(dir: string): string[] {
  const hasil: string[] = [];
  for (const nama of readdirSync(dir)) {
    const penuh = join(dir, nama);
    if (statSync(penuh).isDirectory()) {
      if (nama === '__tests__') continue;
      hasil.push(...berkasTs(penuh));
    } else if (nama.endsWith('.ts')) {
      hasil.push(penuh);
    }
  }
  return hasil;
}

describe('G3 · tidak ada penyelesai izin kedua', () => {
  const berkas = berkasTs(SRC).map((f) => ({
    jalur: relative(process.cwd(), f).replace(/\\/g, '/'),
    isi: readFileSync(f, 'utf8'),
  }));

  it('menemukan berkas untuk dipindai — pemindainya sendiri harus hidup', () => {
    /* Gerbang yang tidak memindai apa pun selalu hijau. Ini yang membuktikan
       ia benar-benar melihat kodenya. */
    expect(berkas.length).toBeGreaterThan(50);
    expect(berkas.some((b) => b.jalur === PENYELESAI)).toBe(true);
  });

  it('hanya penyelesai yang membandingkan walletAccounts.userId', () => {
    /*
       ── INTI G3 ────────────────────────────────────────────────────────

       Sebelum dompet bersama ada, kepemilikan diperiksa di LIMA tempat dengan
       kalimat yang sama. Kelimanya sepakat karena kebetulan menulis hal yang
       sama, bukan karena ada yang memaksa mereka sepakat.

       Begitu sebuah dompet dapat diakses orang selain pemiliknya, tempat yang
       tertinggal tidak gagal dengan berisik: ia diam-diam menolak anggota yang
       sah, atau diam-diam menerima orang yang bukan siapa-siapa.

       Baris ini yang memaksanya. Pemeriksaan izin dompet yang ditulis di
       tempat lain membuat uji ini MERAH sebelum sempat masuk ke cabang mana
       pun.
    */
    const pelanggar = berkas
      .filter((b) => b.jalur !== PENYELESAI && !DIKECUALIKAN.has(b.jalur))
      .filter((b) => /walletAccounts\.userId/.test(b.isi))
      .map((b) => b.jalur);

    expect(
      pelanggar,
      `izin dompet hanya boleh diputuskan di ${PENYELESAI}; ditemukan juga di: ${pelanggar.join(', ')}`,
    ).toEqual([]);
  });

  it('hanya penyelesai yang membaca tabel walletShares', () => {
    /* Arah yang sama dari sisi sebaliknya: kueri yang membaca `walletShares`
       sendiri sedang menyusun keputusan izinnya sendiri. */
    const pelanggar = berkas
      .filter((b) => b.jalur !== PENYELESAI && !DIKECUALIKAN.has(b.jalur))
      .filter((b) => /walletShares\.(role|memberId)/.test(b.isi))
      .map((b) => b.jalur);

    expect(pelanggar, `pembaca walletShares di luar penyelesai: ${pelanggar.join(', ')}`).toEqual(
      [],
    );
  });
});
