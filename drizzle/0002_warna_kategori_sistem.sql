-- Menyelaraskan warna kategori SISTEM dengan palet produk.
--
-- MENGAPA MIGRASI, BUKAN PERBAIKAN SEED
--
-- `seed.ts` sudah memuat palet yang benar sejak commit 4f8bd85, tetapi ia
-- BERPENJAGA: kalau kategori sistem sudah ada, penyemaian dilewati seluruhnya.
-- Akibatnya perbaikan itu hanya berlaku bagi basis data yang lahir SESUDAHNYA.
-- Setiap pemasangan yang sudah berjalan tetap menyajikan palet lama — termasuk
-- `#3b82f6` dan `#f97316`, dua warna yang `globals.css` nyatakan sudah dibuang
-- dari produk, dan yang tetap tampil di donut dasbor serta grafik analitik.
--
-- CAKUPAN SENGAJA SEMPIT
--
--   * HANYA baris `user_id IS NULL` — kategori sistem, yang dibagi semua
--     pengguna dan memang tidak dapat mereka ubah.
--   * Kategori BUATAN PENGGUNA tidak disentuh: warnanya pilihan mereka.
--   * Tidak ada tabel lain, tidak ada baris yang dihapus, tidak ada kolom yang
--     berubah bentuk. Warna adalah data presentasi; tidak ada logika yang
--     bergantung padanya.
--
-- Nilai di bawah DISALIN dari `src/modules/ledger/seed.ts`. Pada basis data
-- baru pernyataan ini mencocoki nol baris — penyemaian belum berjalan saat
-- migrasi diterapkan — dan itu benar, bukan kegagalan.
--
-- Tidak ada `updated_at` di sini: tabel `categories` memang tidak punya kolom
-- itu. Hanya `created_at`, dan baris ini tidak dibuat ulang.

UPDATE categories
SET color = CASE
      WHEN name = 'Gaji' AND kind = 'income' THEN '#3a8f6b'
      WHEN name = 'Usaha' AND kind = 'income' THEN '#3f8c87'
      WHEN name = 'Investasi' AND kind = 'income' THEN '#4b85af'
      WHEN name = 'Hadiah' AND kind = 'income' THEN '#628b44'
      WHEN name = 'Lainnya' AND kind = 'income' THEN '#5c8a68'
      WHEN name = 'Makan & Minum' AND kind = 'expense' THEN '#bb6a51'
      WHEN name = 'Belanja' AND kind = 'expense' THEN '#b76691'
      WHEN name = 'Transportasi' AND kind = 'expense' THEN '#5881bb'
      WHEN name = 'Tagihan & Utilitas' AND kind = 'expense' THEN '#8078b6'
      WHEN name = 'Rumah' AND kind = 'expense' THEN '#9074b1'
      WHEN name = 'Kesehatan' AND kind = 'expense' THEN '#bd6574'
      WHEN name = 'Pendidikan' AND kind = 'expense' THEN '#3d8a9d'
      WHEN name = 'Hiburan' AND kind = 'expense' THEN '#a869b1'
      WHEN name = 'Pulsa & Internet' AND kind = 'expense' THEN '#3f8b93'
      WHEN name = 'Zakat & Donasi' AND kind = 'expense' THEN '#7a8642'
      WHEN name = 'Asuransi' AND kind = 'expense' THEN '#727eac'
      WHEN name = 'Pajak' AND kind = 'expense' THEN '#788091'
      WHEN name = 'Lainnya' AND kind = 'expense' THEN '#7f7f8b'
      ELSE color
    END
WHERE user_id IS NULL;
