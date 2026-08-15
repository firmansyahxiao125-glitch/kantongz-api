import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  Budget,
  Category,
  DashboardSummary,
  Goal,
  RecurringRule,
  Transaction,
  WalletAccount,
} from '../../../contracts/ledger.js';
import type { Session } from '../../../contracts/auth.js';
import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';

/**
 * X1 — UJI KARAKTERISASI, ditulis SEBELUM F3 dan G3 menyentuh apa pun.
 *
 * ── APA BEDANYA DARI UJI BIASA ─────────────────────────────────────────
 *
 * Uji biasa menyatakan apa yang SEHARUSNYA terjadi. Uji karakterisasi
 * menyatakan apa yang SEDANG terjadi — termasuk hal yang tidak pernah
 * dirancang siapa pun, dan justru karena itu paling mudah rusak tanpa ada
 * yang sadar.
 *
 * Ia ditulis lebih dulu dengan sengaja. Dua perubahan berikutnya menyentuh
 * bagian yang paling berbahaya di seluruh basis kode ini:
 *
 *   F3  transaksi terbelah — menambahkan bagian yang punya kategori sendiri.
 *       Risikonya `category_id` induknya berhenti dipakai diam-diam, dan
 *       seluruh atribusi anggaran ikut bergeser tanpa satu galat pun.
 *
 *   G3  dompet bersama — melonggarkan kepemilikan yang selama ini tunggal.
 *       Risikonya batas antar-pengguna bocor: kelas kerentanan paling umum
 *       di aplikasi keuangan, dan yang paling sunyi.
 *
 * Berkas ini karena itu tidak menilai apakah perilakunya BAGUS. Ia hanya
 * memakukannya. Kalau F3 atau G3 mengubah salah satunya, ia harus merah —
 * dan orang yang mengubahnya harus memutuskan secara sadar apakah perubahan
 * itu memang diinginkan.
 */

let h: Harness;
let alice = '';
let bob = '';

const PASSWORD = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();
  alice = await masuk('x1-alice@contoh.id');
  bob = await masuk('x1-bob@contoh.id');
}, 120_000);

afterAll(async () => {
  await h.close();
});

async function masuk(email: string): Promise<string> {
  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { fullName: 'Penguji', email, password: PASSWORD, device: DEVICE },
  });
  const ticket = reg.json<{ data: { ticket: string } }>().data.ticket;

  const verify = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { ticket, code: h.lastCode()?.code, device: DEVICE },
  });

  return verify.json<{ data: Session }>().data.tokens.accessToken;
}

function api(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function data<T>(response: Promise<LightMyRequestResponse>): Promise<T> {
  const res = await response;
  if (res.statusCode >= 400) throw new Error(`${String(res.statusCode)} ${res.body}`);
  return res.json<{ data: T }>().data;
}

/* ══ 1. KATEGORI: apa yang F3 tidak boleh menggeser ═══════════════════ */

describe('X1 · atribusi kategori (dipaku sebelum F3)', () => {
  let dompet = '';
  let kategori = '';
  let kategoriLain = '';

  beforeAll(async () => {
    dompet = (
      await data<WalletAccount>(api(alice, 'POST', '/v1/accounts', { name: 'X1 Kas', kind: 'cash' }))
    ).id;

    const semua = await data<Category[]>(api(alice, 'GET', '/v1/categories'));
    const pengeluaran = semua.filter((c) => c.kind === 'expense');
    kategori = pengeluaran[0]?.id ?? '';
    kategoriLain = pengeluaran[1]?.id ?? '';
    expect(kategori).not.toBe('');
    expect(kategoriLain).not.toBe('');
  }, 60_000);

  it('transaksi menyimpan categoryId dan MENGEMBALIKANNYA apa adanya', async () => {
    const t = await data<Transaction>(
      api(alice, 'POST', '/v1/transactions', {
        accountId: dompet,
        categoryId: kategori,
        kind: 'expense',
        amount: 25_000,
        occurredAt: Date.now(),
        merchant: 'X1 Kopi',
      }),
    );

    expect(t.categoryId).toBe(kategori);

    /* Dibaca kembali lewat DAFTAR, bukan lewat `GET /v1/transactions/:id`.

       Rute itu TIDAK ADA — ditemukan justru oleh uji ini, yang memang salah
       satu gunanya: dugaan tentang permukaan API diperiksa terhadap
       permukaan yang sebenarnya, bukan terhadap ingatan. */
    const halaman = await data<{ items: Transaction[] }>(
      api(alice, 'GET', '/v1/transactions?limit=50'),
    );
    const dibaca = halaman.items.find((x) => x.id === t.id);
    expect(dibaca?.categoryId).toBe(kategori);
  }, 30_000);

  it('anggaran menghitung HANYA transaksi berkategori sama', async () => {
    const anggaran = await data<Budget>(
      api(alice, 'POST', '/v1/budgets', {
        categoryId: kategori,
        period: 'monthly',
        amount: 1_000_000,
      }),
    );

    const sebelum = (await data<Budget[]>(api(alice, 'GET', '/v1/budgets'))).find(
      (b) => b.id === anggaran.id,
    );

    /* Satu transaksi di kategori LAIN. Kalau ia ikut terhitung, atribusi
       kategorinya sudah rusak — dan itu persis yang F3 paling mungkin
       merusak. */
    await data<Transaction>(
      api(alice, 'POST', '/v1/transactions', {
        accountId: dompet,
        categoryId: kategoriLain,
        kind: 'expense',
        amount: 500_000,
        occurredAt: Date.now(),
      }),
    );

    const sesudah = (await data<Budget[]>(api(alice, 'GET', '/v1/budgets'))).find(
      (b) => b.id === anggaran.id,
    );

    expect(sesudah?.spent).toBe(sebelum?.spent);
  }, 60_000);

  it('rincian kategori dasbor menjumlahkan menurut categoryId', async () => {
    const d = await data<DashboardSummary>(api(alice, 'GET', '/v1/dashboard'));
    const baris = d.topCategories.find((c) => c.categoryId === kategoriLain);

    expect(baris).toBeDefined();
    expect(baris?.total).toBeGreaterThan(0);
    /* Setiap baris membawa id-nya, bukan hanya namanya. Nama dapat berubah;
       id yang menjadi jangkar atribusi. */
    expect(d.topCategories.every((c) => 'categoryId' in c)).toBe(true);
  }, 30_000);

  it('transaksi TANPA kategori tetap sah dan tetap terbaca', async () => {
    const t = await data<Transaction>(
      api(alice, 'POST', '/v1/transactions', {
        accountId: dompet,
        kind: 'expense',
        amount: 10_000,
        occurredAt: Date.now(),
      }),
    );

    /* Ini perilaku yang SEDANG berlaku, bukan yang ideal. Dipaku supaya F3
       tidak diam-diam menjadikan kategori wajib — perubahan yang akan
       menolak data lama milik pengguna yang sudah ada. */
    expect(t.categoryId).toBeNull();
  }, 30_000);
});

/* ══ 2. IDOR: matriks penuh yang G3 tidak boleh melonggarkan ══════════ */

describe('X1 · batas antar-pengguna (dipaku sebelum G3)', () => {
  const milikAlice: Record<string, string> = {};

  beforeAll(async () => {
    const dompet = await data<WalletAccount>(
      api(alice, 'POST', '/v1/accounts', { name: 'X1 Milik Alice', kind: 'bank' }),
    );
    milikAlice.accounts = dompet.id;

    /* Kategori KETIGA, bukan pertama.

       Blok sebelumnya sudah memakai dua yang pertama untuk anggaran, dan
       anggaran unik per (kategori, periode) — memakainya lagi menghasilkan
       409, bukan temuan. Uji yang bertabrakan dengan uji lain menguji
       urutan eksekusi, bukan perilaku. */
    const kategori = (await data<Category[]>(api(alice, 'GET', '/v1/categories'))).filter(
      (c) => c.kind === 'expense',
    )[2];

    milikAlice.transactions = (
      await data<Transaction>(
        api(alice, 'POST', '/v1/transactions', {
          accountId: dompet.id,
          kind: 'expense',
          amount: 15_000,
          occurredAt: Date.now(),
        }),
      )
    ).id;

    milikAlice.budgets = (
      await data<Budget>(
        api(alice, 'POST', '/v1/budgets', {
          categoryId: kategori?.id,
          period: 'monthly',
          amount: 750_000,
        }),
      )
    ).id;

    milikAlice.goals = (
      await data<Goal>(
        api(alice, 'POST', '/v1/goals', { name: 'X1 Tujuan Alice', targetAmount: 5_000_000 }),
      )
    ).id;

    milikAlice.recurring = (
      await data<RecurringRule>(
        api(alice, 'POST', '/v1/recurring', {
          name: 'X1 Langganan',
          accountId: dompet.id,
          kind: 'expense',
          amount: 99_000,
          cadence: 'monthly',
          startsOn: '2026-08-01',
        }),
      )
    ).id;
  }, 120_000);

  /**
   * Matriks, bukan contoh.
   *
   * Menguji satu rute lalu menganggap sisanya ikut aman adalah cara kebocoran
   * IDOR bertahan bertahun-tahun: yang bocor hampir selalu rute yang
   * ditambahkan belakangan, bukan yang diperiksa waktu pertama kali ditulis.
   *
   * `404`, bukan `403`. Membedakan keduanya memberi tahu penyerang id mana
   * yang benar-benar ada — kebocoran yang lebih kecil, dan tetap kebocoran.
   */
  /**
   * Matriks yang mencerminkan rute yang BENAR-BENAR terdaftar.
   *
   * Versi pertama berkas ini menebak verb-nya — PATCH untuk transaksi, DELETE
   * untuk dompet — dan menabrak 404 "Rute tidak ditemukan". Itu 404 yang
   * SALAH: ia berarti rutenya tidak ada, bukan berarti kepemilikannya ditolak.
   * Uji yang lulus karena rutenya tidak ada adalah uji yang tidak menjaga
   * apa pun, dan itu bentuk kegagalan yang paling sunyi.
   *
   * Daftar di bawah dibaca dari `routes.ts`:
   *   accounts      PATCH
   *   transactions  PUT · DELETE
   *   budgets       PATCH · DELETE
   *   goals         DELETE · POST /contribute
   *   recurring     PUT · DELETE · POST /pause
   *
   * `404`, bukan `403`. Membedakan keduanya memberi tahu penyerang id mana
   * yang benar-benar ada — kebocoran yang lebih kecil, dan tetap kebocoran.
   */
  const RUTE: {
    sumber: string;
    metode: 'PUT' | 'PATCH' | 'DELETE' | 'POST';
    jalur: (id: string) => string;
    muatan?: Record<string, unknown>;
  }[] = [
    { sumber: 'accounts', metode: 'PATCH', jalur: (id) => `/v1/accounts/${id}`, muatan: { name: 'Dibajak' } },
    {
      sumber: 'transactions',
      metode: 'PUT',
      jalur: (id) => `/v1/transactions/${id}`,
      /* `accountId` wajib di skema transaksi; tanpanya 422 datang dari
         validator dan uji ini berhenti menguji kepemilikan. */
      muatan: {
        accountId: '00000000-0000-4000-8000-000000000000',
        kind: 'expense',
        amount: 1,
        occurredAt: Date.now(),
      },
    },
    { sumber: 'transactions', metode: 'DELETE', jalur: (id) => `/v1/transactions/${id}` },
    {
      sumber: 'budgets',
      /* `updateBudget` hanya menerima `{ rollover }` — bukan `amount`.
         Dibaca dari skemanya, bukan dari dugaan tentang apa yang "wajar"
         dapat diubah pada sebuah anggaran. */
      metode: 'PATCH',
      jalur: (id) => `/v1/budgets/${id}`,
      muatan: { rollover: true },
    },
    { sumber: 'budgets', metode: 'DELETE', jalur: (id) => `/v1/budgets/${id}` },
    { sumber: 'goals', metode: 'DELETE', jalur: (id) => `/v1/goals/${id}` },
    {
      sumber: 'goals',
      metode: 'POST',
      jalur: (id) => `/v1/goals/${id}/contribute`,
      muatan: { amount: 1000 },
    },
    {
      sumber: 'recurring',
      metode: 'PUT',
      jalur: (id) => `/v1/recurring/${id}`,
      muatan: {
        name: 'Dibajak',
        accountId: '00000000-0000-4000-8000-000000000000',
        kind: 'expense',
        amount: 1,
        cadence: 'monthly',
        startsOn: '2026-08-01',
      },
    },
    {
      sumber: 'recurring',
      metode: 'POST',
      jalur: (id) => `/v1/recurring/${id}/pause`,
      /* Muatannya harus SAH.

         Versi pertama mengirim `{}` dan mendapat 422, bukan 404 — karena
         validasi skema berjalan SEBELUM pemeriksaan kepemilikan. Itu urutan
         yang benar untuk keamanannya (422 tidak membocorkan apakah id-nya
         ada), tetapi salah untuk uji ini: permintaan yang ditolak validator
         tidak pernah sampai ke batas yang sedang diuji.

         Uji IDOR yang lulus karena muatannya tidak sah tidak menjaga apa pun. */
      muatan: { paused: true },
    },
    { sumber: 'recurring', metode: 'DELETE', jalur: (id) => `/v1/recurring/${id}` },
  ];

  it('Bob tidak dapat menyentuh SATU PUN sumber daya Alice', async () => {
    const bocor: string[] = [];

    for (const r of RUTE) {
      const id = milikAlice[r.sumber];
      if (id === undefined) continue;
      const res = await api(bob, r.metode, r.jalur(id), r.muatan);
      if (res.statusCode !== 404) bocor.push(`${r.metode} ${r.jalur(id)} -> ${String(res.statusCode)}`);
    }

    expect(bocor).toEqual([]);
  }, 120_000);

  it('daftar milik Bob tidak pernah memuat sumber daya Alice', async () => {
    const dompet = await data<WalletAccount[]>(api(bob, 'GET', '/v1/accounts'));
    const tujuan = await data<Goal[]>(api(bob, 'GET', '/v1/goals'));
    const anggaran = await data<Budget[]>(api(bob, 'GET', '/v1/budgets'));
    const berulang = await data<RecurringRule[]>(api(bob, 'GET', '/v1/recurring'));

    expect(dompet.map((x) => x.id)).not.toContain(milikAlice.accounts);
    expect(tujuan.map((x) => x.id)).not.toContain(milikAlice.goals);
    expect(anggaran.map((x) => x.id)).not.toContain(milikAlice.budgets);
    expect(berulang.map((x) => x.id)).not.toContain(milikAlice.recurring);
  }, 60_000);

  it('Bob tidak dapat MENULIS ke dompet Alice lewat transaksi barunya sendiri', async () => {
    /* Serangan yang paling mudah terlewat: bukan membaca milik orang lain,
       melainkan MENITIPKAN sesuatu ke sana. Kalau ini lolos, saldo Alice
       berubah tanpa Alice pernah menyentuh apa pun. */
    const res = await api(bob, 'POST', '/v1/transactions', {
      accountId: milikAlice.accounts,
      kind: 'expense',
      amount: 1_000_000,
      occurredAt: Date.now(),
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  }, 30_000);

  it('sumber daya Alice tetap UTUH sesudah seluruh percobaan Bob', async () => {
    /* Penegasan penutup yang berbeda jenis: bukan "Bob ditolak" melainkan
       "tidak ada yang berubah". Penolakan yang mengembalikan 404 tetapi
       sempat menulis lebih dulu akan lolos pemeriksaan status dan tetap
       merusak data. */
    const dompet = await data<WalletAccount[]>(api(alice, 'GET', '/v1/accounts'));
    const tujuan = await data<Goal[]>(api(alice, 'GET', '/v1/goals'));

    expect(dompet.map((x) => x.id)).toContain(milikAlice.accounts);
    expect(tujuan.find((x) => x.id === milikAlice.goals)?.savedAmount).toBe(0);
  }, 60_000);
});
