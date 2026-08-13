import { DomainError } from '../../contracts/domain.js';

/**
 * Pelanggaran indeks unik → konflik domain.
 *
 * ── MASALAH YANG DIPECAHKAN ────────────────────────────────────────────
 *
 * `openapi.json` MENJANJIKAN 409 pada `POST /v1/budgets`, `/v1/accounts`, dan
 * `/v1/categories`. Ketiganya mengembalikan 500. Diukur, bukan diduga:
 *
 *   POST /v1/budgets     duplikat -> 500 unknown   (dijanjikan 409)
 *   POST /v1/categories  duplikat -> 500 unknown   (dijanjikan 409)
 *   POST /v1/accounts    duplikat -> 500 unknown   (dijanjikan 409)
 *
 * Sebabnya satu dan sama: tidak ada satu pun jalur yang menerjemahkan
 * pelanggaran indeks unik. Basis data menolak dengan benar, lalu penolakan itu
 * jatuh ke cabang terakhir penangan galat dan menjadi "kesalahan tak terduga" —
 * padahal ia sepenuhnya terduga dan sudah tertulis di kontrak.
 *
 * ── MENGAPA DI SINI, BUKAN DI SETIAP SERVICE ───────────────────────────
 *
 * Alternatifnya adalah SELECT pendahulu di tiap service. Itu tiga perubahan
 * untuk satu sebab, dan ketiganya BALAPAN: antara SELECT dan INSERT, permintaan
 * lain bisa menyisipkan baris yang sama, dan 500 kembali muncul justru pada
 * beban tinggi tempat ia paling merugikan. Indeks unik adalah satu-satunya
 * penengah yang tidak bisa kalah balapan; yang kurang hanyalah menerjemahkan
 * jawabannya.
 *
 * Pengetahuan SQLSTATE berhenti di berkas ini. Lapisan HTTP hanya memanggil
 * `asConflict` dan menerima `DomainError` biasa.
 */

/** Pelanggaran unik, SQLSTATE PostgreSQL. */
const UNIQUE_VIOLATION = '23505';

/**
 * Pesan per kendala.
 *
 * Nama indeks dipakai sebagai kunci karena ia SATU-SATUNYA hal yang dikirim
 * PostgreSQL yang benar-benar menunjuk aturan yang dilanggar. Kendala yang
 * tidak terdaftar tetap menjadi 409 dengan kalimat umum: status yang benar
 * lebih penting daripada kalimat yang sempurna, dan 500 adalah jawaban yang
 * salah untuk keduanya.
 *
 * Pesan SENGAJA tidak mengutip nilai yang dikirim pengguna. Kolomnya sebagian
 * terenkripsi, dan memantulkan masukan kembali ke layar adalah cara termudah
 * membocorkan apa yang tersimpan.
 */
const PESAN: Record<string, string> = {
  budgets_one_active_per_category: 'sudah ada anggaran aktif untuk kategori ini',
  wallet_accounts_user_name: 'sudah ada dompet dengan nama itu',
  categories_user_name: 'sudah ada kategori dengan nama dan jenis itu',
  categories_system_name: 'nama itu dipakai kategori bawaan',
  goals_user_name: 'sudah ada tujuan dengan nama itu',
  devices_user_hash: 'perangkat ini sudah terdaftar',
  users_email_active: 'akun dengan data itu sudah ada',
};

/** Batas penelusuran rantai `cause`. Rantai melingkar akan menggantung proses,
 *  dan pembungkus driver tidak pernah sedalam ini. */
const KEDALAMAN_MAKS = 8;

/**
 * Mengembalikan `DomainError` konflik kalau galatnya pelanggaran unik, atau
 * `null` kalau bukan — sehingga pemanggil dapat meneruskan galat aslinya.
 *
 * Rantai `cause` DITELUSURI, dan itu wajib: Drizzle membungkus galat driver di
 * dalam `DrizzleQueryError`, jadi SQLSTATE tidak pernah ada di objek terluar.
 * Diperiksa langsung terhadap basis data yang berjalan — `PostgresError`,
 * `code: '23505'`, `constraint_name: 'budgets_one_active_per_category'`.
 */
export function asConflict(error: unknown): DomainError | null {
  let current: unknown = error;

  for (let i = 0; i < KEDALAMAN_MAKS && current !== null && current !== undefined; i += 1) {
    const kandidat = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };

    if (kandidat.code === UNIQUE_VIOLATION) {
      const nama = typeof kandidat.constraint_name === 'string' ? kandidat.constraint_name : '';
      return new DomainError('conflict', PESAN[nama] ?? 'data yang sama sudah ada');
    }

    current = kandidat.cause;
  }

  return null;
}
