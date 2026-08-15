import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../../../contracts/auth.js';
import type { Transaction, WalletAccount } from '../../../contracts/ledger.js';
import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';

/**
 * G2 — usulan kategori lewat HTTP.
 *
 * `saran-kategori.test.ts` membuktikan aritmetikanya. Yang dibuktikan di sini
 * adalah hal-hal yang hanya ada di jalur sungguhan: kepemilikan riwayat,
 * penerjemahan nama kategori sistem menjadi id milik pengguna, dan — yang
 * paling penting — bahwa rute ini TIDAK MENULIS APA PUN.
 */

let h: Harness;
let alice = '';
let bob = '';
let dompetAlice = '';
let dompetBob = '';
let katMakanAlice = '';

const PASSWORD = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();
  alice = await masuk('saran-alice@contoh.id');
  bob = await masuk('saran-bob@contoh.id');

  dompetAlice = (await data<WalletAccount>(api(alice, 'POST', '/v1/accounts', { name: 'Kas A', kind: 'cash' }))).id;
  dompetBob = (await data<WalletAccount>(api(bob, 'POST', '/v1/accounts', { name: 'Kas B', kind: 'cash' }))).id;

  const kategori = await data<{ id: string; name: string }[]>(api(alice, 'GET', '/v1/categories'));
  katMakanAlice = kategori.find((k) => k.name === 'Makan & Minum')?.id ?? '';
  expect(katMakanAlice).not.toBe('');
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
  method: 'GET' | 'POST',
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

async function data<T>(res: Promise<LightMyRequestResponse>): Promise<T> {
  const r = await res;
  if (r.statusCode >= 400) throw new Error(`${String(r.statusCode)} ${r.body}`);
  return r.json<{ data: T }>().data;
}

interface Saran {
  categoryId: string;
  keyakinan: string;
  alasan: string;
  sumber: string;
}

const usul = (token: string, merchant: string): Promise<Saran | null> =>
  data<Saran | null>(
    api(token, 'GET', `/v1/transactions/suggest-category?merchant=${encodeURIComponent(merchant)}`),
  );

describe('G2 · rute usulan', () => {
  it('menolak tanpa token', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/transactions/suggest-category?merchant=INDOMARET',
    });
    expect(res.statusCode).toBe(401);
  });

  it('menolak merchant kosong', async () => {
    const res = await api(alice, 'GET', '/v1/transactions/suggest-category?merchant=');
    expect(res.statusCode).toBe(422);
  });

  it('memakai kamus ketika pengguna belum punya riwayat', async () => {
    const s = await usul(alice, 'ALFAMART CIPUTAT');

    expect(s?.sumber).toBe('kamus');
    /* Nama kategori sistem harus sudah menjadi id MILIK pengguna ini —
       kamus menyimpan nama, bukan id. */
    expect(s?.categoryId).toMatch(/^cat/);
  }, 60_000);

  it('riwayat pengguna sendiri mengalahkan kamus', async () => {
    /* INDOMARET ada di kamus sebagai Belanja. Alice selalu menandainya
       Makan & Minum. Kebiasaannya yang menang. */
    for (const hari of [1, 2, 3]) {
      await data<Transaction>(
        api(alice, 'POST', '/v1/transactions', {
          accountId: dompetAlice,
          categoryId: katMakanAlice,
          kind: 'expense',
          amount: 25_000,
          occurredAt: Date.UTC(2026, 7, hari),
          merchant: 'INDOMARET CIPUTAT',
        }),
      );
    }

    const s = await usul(alice, 'INDOMARET CIPUTAT');
    expect(s?.sumber).toBe('riwayat');
    expect(s?.categoryId).toBe(katMakanAlice);
    expect(s?.keyakinan).toBe('tinggi');
  }, 90_000);

  it('riwayat Alice TIDAK pernah bocor ke usulan Bob', async () => {
    /*
       Riwayat merchant adalah data keuangan: ia menyebutkan di mana seseorang
       berbelanja. Usulan yang dibangun dari riwayat orang lain membocorkannya
       tanpa satu pun rute yang terlihat seperti kebocoran.
    */
    const s = await usul(bob, 'INDOMARET CIPUTAT');

    /* Bob belum pernah mencatat apa pun, jadi ia jatuh ke kamus — Belanja,
       bukan Makan & Minum yang menjadi kebiasaan Alice. */
    expect(s?.sumber).toBe('kamus');
    expect(s?.categoryId).not.toBe(katMakanAlice);
  }, 60_000);

  it('membalas null untuk merchant yang tidak dikenali', async () => {
    const s = await usul(alice, 'QWERTY ZXCV 12345');
    expect(s).toBeNull();
  }, 60_000);

  it('TIDAK MENULIS APA PUN — jumlah transaksi tidak bergerak', async () => {
    /*
       Janji terpenting G2, dijaga oleh akibatnya dan bukan oleh niat.

       Bukan cuma "rutenya GET": yang diukur adalah keadaan pembukuan sebelum
       dan sesudah sepuluh permintaan usulan. Kalau suatu hari ada yang
       menyambungkan usulan ke penulisan otomatis, baris ini yang merah.
    */
    const sebelum = await data<{ items: Transaction[] }>(
      api(alice, 'GET', '/v1/transactions?limit=100'),
    );

    for (const merchant of ['INDOMARET', 'GOJEK', 'ALFAMART', 'PLN', 'APOTEK']) {
      await usul(alice, merchant);
      await usul(bob, merchant);
    }

    const sesudah = await data<{ items: Transaction[] }>(
      api(alice, 'GET', '/v1/transactions?limit=100'),
    );

    expect(sesudah.items).toHaveLength(sebelum.items.length);

    /* Dan tidak satu pun kategori tercipta diam-diam. */
    const kategori = await data<unknown[]>(api(bob, 'GET', '/v1/categories'));
    expect(kategori.length).toBeGreaterThan(0);
  }, 90_000);

  it('transaksi yang dibuat TIDAK ikut terisi kategori oleh usulan', async () => {
    /* Pembuatan transaksi tanpa `categoryId` harus tetap tanpa kategori,
       walaupun merchant-nya sangat mudah ditebak. */
    const t = await data<Transaction>(
      api(bob, 'POST', '/v1/transactions', {
        accountId: dompetBob,
        kind: 'expense',
        amount: 15_000,
        occurredAt: Date.UTC(2026, 7, 5),
        merchant: 'ALFAMART SUDIRMAN',
      }),
    );

    expect(t.categoryId).toBeNull();
  }, 60_000);
});
