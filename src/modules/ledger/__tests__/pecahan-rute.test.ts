import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../../../contracts/auth.js';
import type { Transaction, WalletAccount } from '../../../contracts/ledger.js';
import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';

/**
 * F3 — pemecahan lewat jalur sungguhan.
 *
 * `pecahan.test.ts` membuktikan aturannya. Yang dibuktikan di sini adalah dua
 * hal yang hanya ada di basis data: bahwa `category_id` TIDAK dibuang, dan
 * bahwa laporan yang kini membaca pecahan tidak menghitung uang dua kali.
 */

let h: Harness;
let alice = '';
let bob = '';
let dompet = '';
let dompetBob = '';
let makan = '';
let belanja = '';
let rumah = '';

const PASSWORD = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();
  alice = await masuk('pecah-alice@contoh.id');
  bob = await masuk('pecah-bob@contoh.id');

  dompet = (await d<WalletAccount>(api(alice, 'POST', '/v1/accounts', { name: 'Kas', kind: 'cash' }))).id;
  dompetBob = (await d<WalletAccount>(api(bob, 'POST', '/v1/accounts', { name: 'Kas B', kind: 'cash' }))).id;

  const kategori = await d<{ id: string; name: string; kind: string }[]>(
    api(alice, 'GET', '/v1/categories'),
  );
  const cari = (nama: string): string => kategori.find((k) => k.name === nama)?.id ?? '';
  makan = cari('Makan & Minum');
  belanja = cari('Belanja');
  rumah = cari('Rumah');
  expect([makan, belanja, rumah].every((x) => x !== '')).toBe(true);
}, 150_000);

afterAll(async () => {
  await h.close();
});

async function masuk(email: string): Promise<string> {
  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { fullName: 'Penguji', email, password: PASSWORD, device: DEVICE },
  });
  const verify = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: {
      ticket: reg.json<{ data: { ticket: string } }>().data.ticket,
      code: h.lastCode()?.code,
      device: DEVICE,
    },
  });
  return verify.json<{ data: Session }>().data.tokens.accessToken;
}

function api(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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

async function d<T>(res: Promise<LightMyRequestResponse>): Promise<T> {
  const r = await res;
  if (r.statusCode >= 400) throw new Error(`${String(r.statusCode)} ${r.body}`);
  return r.json<{ data: T }>().data;
}

async function buatBelanja(amount: number, hari = 3, token = alice): Promise<Transaction> {
  return d<Transaction>(
    api(token, 'POST', '/v1/transactions', {
      accountId: token === alice ? dompet : dompetBob,
      kind: 'expense',
      amount,
      occurredAt: Date.UTC(2026, 7, hari),
      merchant: 'SUPERINDO',
    }),
  );
}

describe('F3 · category_id TIDAK dibuang', () => {
  it('mengikuti pecahan TERBESAR sesudah dipecah', async () => {
    const t = await buatBelanja(50_000);

    const hasil = await d<Transaction>(
      api(alice, 'PUT', `/v1/transactions/${t.id}/splits`, {
        splits: [
          { categoryId: makan, amount: 20_000 },
          { categoryId: belanja, amount: 30_000 },
        ],
      }),
    );

    /* Inti F3: kolomnya tetap berisi, dan berisi sesuatu yang berarti. */
    expect(hasil.categoryId).toBe(belanja);
    expect(hasil.splits).toHaveLength(2);
    expect(hasil.splits?.reduce((s, p) => s + p.amount, 0)).toBe(50_000);
  }, 60_000);

  it('transaksi tanpa pecahan membalas splits null, bukan larik kosong', async () => {
    const t = await buatBelanja(11_000);
    expect(t.splits).toBeNull();

    const halaman = await d<{ items: Transaction[] }>(
      api(alice, 'GET', '/v1/transactions?limit=100'),
    );
    const lagi = halaman.items.find((x) => x.id === t.id);
    expect(lagi?.splits).toBeNull();
  }, 60_000);

  it('membatalkan pemecahan menyisakan transaksinya utuh', async () => {
    const t = await buatBelanja(40_000);
    await d<Transaction>(
      api(alice, 'PUT', `/v1/transactions/${t.id}/splits`, {
        splits: [
          { categoryId: makan, amount: 25_000 },
          { categoryId: rumah, amount: 15_000 },
        ],
      }),
    );

    const kosong = await d<Transaction>(api(alice, 'DELETE', `/v1/transactions/${t.id}/splits`));
    expect(kosong.splits).toBeNull();
    expect(kosong.amount).toBe(40_000);
    /* Kategori utamanya tetap — pembatalan bukan pengosongan. */
    expect(kosong.categoryId).toBe(makan);
  }, 60_000);
});

describe('F3 · laporan tidak menghitung ganda', () => {
  it('total pengeluaran TIDAK berubah sesudah transaksi dipecah', async () => {
    /*
       Uji yang paling penting di berkas ini.

       Agregasi kini `LEFT JOIN transaction_splits`, dan sambungan yang salah
       akan melipatgandakan setiap transaksi berpecahan sebanyak barisnya.
       Yang membuktikannya bukan membaca kuerinya melainkan mengukur totalnya
       sebelum dan sesudah — angkanya harus TIDAK bergerak sedikit pun.
    */
    interface Dasbor {
      monthExpense: number;
      topCategories: { categoryId: string | null; total: number }[];
    }

    const sebelum = await d<Dasbor>(api(alice, 'GET', '/v1/dashboard'));

    const t = await buatBelanja(90_000, 4);
    const sesudahCatat = await d<Dasbor>(api(alice, 'GET', '/v1/dashboard'));
    expect(sesudahCatat.monthExpense).toBe(sebelum.monthExpense + 90_000);

    await d<Transaction>(
      api(alice, 'PUT', `/v1/transactions/${t.id}/splits`, {
        splits: [
          { categoryId: makan, amount: 30_000 },
          { categoryId: belanja, amount: 30_000 },
          { categoryId: rumah, amount: 30_000 },
        ],
      }),
    );

    const sesudahPecah = await d<Dasbor>(api(alice, 'GET', '/v1/dashboard'));

    /* Total keseluruhan tidak bergerak: yang berubah hanya ke kategori mana
       uangnya jatuh. */
    expect(sesudahPecah.monthExpense).toBe(sesudahCatat.monthExpense);

    /* Dan rinciannya pun tidak melebihi totalnya. Sambungan yang salah akan
       melipatgandakan transaksi berpecahan sebanyak barisnya, dan gejalanya
       muncul di sini lebih dulu daripada di angka totalnya. */
    const jumlahRincian = sesudahPecah.topCategories.reduce((s, c) => s + c.total, 0);
    expect(jumlahRincian).toBeLessThanOrEqual(sesudahPecah.monthExpense);
  }, 120_000);

  it('anggaran per kategori MELIHAT bagian pecahannya, bukan seluruh nominal', async () => {
    /* Ini nilai fitur ini: sebelum F3, belanja 90.000 yang sepertiganya makan
       akan membebani anggaran Makan & Minum sebesar 90.000 penuh. */
    const anggaran = await d<{ id: string; spent: number }>(
      api(alice, 'POST', '/v1/budgets', {
        categoryId: rumah,
        period: 'monthly',
        amount: 5_000_000,
      }),
    );
    expect(anggaran.id).toBeTruthy();

    /*
       Diukur sebagai SELISIH, bukan angka mutlak.

       Uji-uji sebelumnya di berkas ini sudah membebani kategori yang sama,
       dan versi pertama baris ini menuntut 40.000 lalu menemukan 70.000 —
       jawaban yang benar terhadap pertanyaan yang salah. Uji yang menuntut
       angka mutlak dari pembukuan bersama akan patah setiap kali uji di
       atasnya berubah, dan yang patah karena tetangganya tidak mengukur apa
       pun tentang dirinya sendiri.
    */
    const awal =
      (await d<{ categoryId: string; spent: number }[]>(api(alice, 'GET', '/v1/budgets'))).find(
        (b) => b.categoryId === rumah,
      )?.spent ?? 0;

    const t = await buatBelanja(100_000, 5);
    await d<Transaction>(
      api(alice, 'PUT', `/v1/transactions/${t.id}/splits`, {
        splits: [
          { categoryId: rumah, amount: 40_000 },
          { categoryId: belanja, amount: 60_000 },
        ],
      }),
    );

    const daftar = await d<{ id: string; categoryId: string; spent: number }[]>(
      api(alice, 'GET', '/v1/budgets'),
    );
    const punyaRumah = daftar.find((b) => b.categoryId === rumah);

    /* Hanya 40.000 dari transaksi itu yang membebani Rumah — bukan 100.000,
       dan bukan nol. */
    expect((punyaRumah?.spent ?? 0) - awal).toBe(40_000);
  }, 120_000);
});

describe('F3 · penolakan', () => {
  it('menolak jumlah yang tidak cocok, dan tidak menulis apa pun', async () => {
    const t = await buatBelanja(50_000, 6);

    const res = await api(alice, 'PUT', `/v1/transactions/${t.id}/splits`, {
      splits: [
        { categoryId: makan, amount: 20_000 },
        { categoryId: belanja, amount: 20_000 },
      ],
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const lagi = await d<{ items: Transaction[] }>(api(alice, 'GET', '/v1/transactions?limit=100'));
    expect(lagi.items.find((x) => x.id === t.id)?.splits).toBeNull();
  }, 60_000);

  it('menolak transfer', async () => {
    const bank = await d<WalletAccount>(
      api(alice, 'POST', '/v1/accounts', { name: 'Bank', kind: 'bank' }),
    );
    const transfer = await d<Transaction>(
      api(alice, 'POST', '/v1/transactions', {
        accountId: dompet,
        counterAccountId: bank.id,
        kind: 'transfer',
        amount: 200_000,
        occurredAt: Date.UTC(2026, 7, 7),
      }),
    );

    const res = await api(alice, 'PUT', `/v1/transactions/${transfer.id}/splits`, {
      splits: [
        { categoryId: makan, amount: 100_000 },
        { categoryId: belanja, amount: 100_000 },
      ],
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('Bob tidak dapat memecah transaksi Alice', async () => {
    const t = await buatBelanja(30_000, 8);
    const res = await api(bob, 'PUT', `/v1/transactions/${t.id}/splits`, {
      splits: [
        { categoryId: makan, amount: 10_000 },
        { categoryId: belanja, amount: 20_000 },
      ],
    });
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it('Bob tidak dapat membatalkan pemecahan Alice', async () => {
    const t = await buatBelanja(30_000, 9);
    const res = await api(bob, 'DELETE', `/v1/transactions/${t.id}/splits`);
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it('menolak kategori milik pengguna lain', async () => {
    /* Kategori BUATAN Bob, bukan kategori sistem yang dilihat keduanya. */
    const punyaBob = await d<{ id: string }>(
      api(bob, 'POST', '/v1/categories', {
        name: 'Rahasia Bob',
        kind: 'expense',
        icon: 'lock',
        color: '#556677',
      }),
    );

    const t = await buatBelanja(30_000, 10);
    const res = await api(alice, 'PUT', `/v1/transactions/${t.id}/splits`, {
      splits: [
        { categoryId: makan, amount: 10_000 },
        { categoryId: punyaBob.id, amount: 20_000 },
      ],
    });

    expect(res.statusCode).toBe(404);
  }, 60_000);
});

describe('F3 · mengubah nominal membuang pecahannya', () => {
  it('pecahan lama tidak boleh bertahan pada nominal yang baru', async () => {
    /* Pecahan lama menjumlah ke nominal LAMA. Membiarkannya membuat satu
       transaksi punya dua nilai, dan laporan yang membaca keduanya tidak akan
       pernah cocok. */
    const t = await buatBelanja(60_000, 11);
    await d<Transaction>(
      api(alice, 'PUT', `/v1/transactions/${t.id}/splits`, {
        splits: [
          { categoryId: makan, amount: 20_000 },
          { categoryId: belanja, amount: 40_000 },
        ],
      }),
    );

    const diubah = await d<Transaction>(
      api(alice, 'PUT', `/v1/transactions/${t.id}`, {
        accountId: dompet,
        kind: 'expense',
        amount: 75_000,
        occurredAt: Date.UTC(2026, 7, 11),
        merchant: 'SUPERINDO',
      }),
    );

    expect(diubah.amount).toBe(75_000);
    expect(diubah.splits).toBeNull();
  }, 90_000);

  it('nominal yang TIDAK berubah mempertahankan pecahannya', async () => {
    /* Kebalikannya juga harus benar: menyunting catatan tidak boleh diam-diam
       menghapus rincian yang susah payah dimasukkan. */
    const t = await buatBelanja(60_000, 12);
    await d<Transaction>(
      api(alice, 'PUT', `/v1/transactions/${t.id}/splits`, {
        splits: [
          { categoryId: makan, amount: 25_000 },
          { categoryId: belanja, amount: 35_000 },
        ],
      }),
    );

    const diubah = await d<Transaction>(
      api(alice, 'PUT', `/v1/transactions/${t.id}`, {
        accountId: dompet,
        kind: 'expense',
        amount: 60_000,
        occurredAt: Date.UTC(2026, 7, 12),
        merchant: 'SUPERINDO CIPUTAT',
      }),
    );

    expect(diubah.splits).toHaveLength(2);
  }, 90_000);
});
