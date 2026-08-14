import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../../../contracts/auth.js';
import type { Budget, Category, WalletAccount } from '../../../contracts/ledger.js';
import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';
import { monthRange } from '../periods.js';
import { listBudgets } from '../service.js';

/**
 * Bawaan sisa anggaran, terhadap riwayat pengeluaran yang sungguhan.
 *
 * ── MENGAPA JAMNYA DIMAJUKAN, BUKAN TANGGALNYA DIMUNDURKAN ──────────────
 *
 * Anggaran berlaku sejak PERIODE IA DIBUAT; periode sebelum itu bukan
 * urusannya. Jadi anggaran yang baru lahir memang belum punya bawaan apa pun,
 * dan menguji bawaan menuntut waktu berjalan.
 *
 * Yang dimajukan adalah `now` yang memang sudah diterima `listBudgets` sebagai
 * parameter — bukan jam sistem yang dipalsukan. Uji yang memalsukan jam global
 * akan mengubah perilaku setiap kode lain yang kebetulan membacanya.
 */

let h: Harness;
let alice = '';
let dompet = '';

const PASSWORD = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();
  alice = await masuk('roll-alice@contoh.id');
  dompet = (
    await data<WalletAccount>(
      api(alice, 'POST', '/v1/accounts', { name: 'Bank Amplop', kind: 'bank' }),
    )
  ).id;
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

/** Tengah bulan, `n` bulan ke depan. Jauh dari kedua tepi periodenya. */
function bulanDepan(n: number): Date {
  const sekarang = new Date();
  const maju = new Date(
    Date.UTC(sekarang.getUTCFullYear(), sekarang.getUTCMonth() + n, 15, 5, 0, 0),
  );
  return maju;
}

/** Tengah bulan berjalan — periode pertama setiap anggaran di berkas ini. */
function bulanIni(): number {
  const r = monthRange(new Date());
  return Math.floor((r.from.getTime() + r.to.getTime()) / 2);
}

/** Kategori baru per uji, supaya belanja satu uji tidak terlihat oleh uji lain. */
async function kategoriBaru(nama: string): Promise<string> {
  const kategori = await data<Category>(
    api(alice, 'POST', '/v1/categories', {
      name: `${nama}-${String(Date.now())}`,
      kind: 'expense',
      icon: 'wallet',
      color: '#8899aa',
    }),
  );
  return kategori.id;
}

async function belanja(categoryId: string, amount: number, occurredAt: number): Promise<void> {
  await data(
    api(alice, 'POST', '/v1/transactions', {
      accountId: dompet,
      kind: 'expense',
      amount,
      categoryId,
      occurredAt,
    }),
  );
}

async function buatAnggaran(categoryId: string, rollover: boolean, amount = 1_000_000): Promise<Budget> {
  return data<Budget>(
    api(alice, 'POST', '/v1/budgets', { categoryId, amount, period: 'monthly', rollover }),
  );
}

/** Anggaran satu kategori, dilihat dari titik waktu tertentu. */
async function lihat(categoryId: string, pada: Date): Promise<Budget> {
  const semua = await listBudgets({ db: h.db }, pemilik, pada);
  const satu = semua.find((b) => b.categoryId === categoryId);
  if (!satu) throw new Error('anggaran tidak ditemukan');
  return satu;
}

/* `listBudgets` dipanggil langsung, jadi ia butuh id pengguna dan bukan token. */
let pemilik = '';

beforeAll(async () => {
  const me = await data<{ id: string }>(api(alice, 'GET', '/v1/auth/me'));
  pemilik = me.id;
});

describe('bawaan sisa', () => {
  it('mati secara bawaan, dan batasnya sama dengan jatahnya', async () => {
    const categoryId = await kategoriBaru('polos');
    await belanja(categoryId, 700_000, bulanIni());
    await buatAnggaran(categoryId, false);

    const b = await lihat(categoryId, bulanDepan(1));
    expect(b.rollover).toBe(false);
    expect(b.carryOver).toBe(0);
    expect(b.limit).toBe(1_000_000);
  });

  it('ANGGARAN BARU BELUM PUNYA BAWAAN APA PUN', async () => {
    /*
     * Anggaran berlaku sejak periode ia dibuat. Menghitung belanja bulan-bulan
     * sebelumnya sebagai pelanggarannya berarti anggaran baru lahir dengan
     * utang yang tidak pernah disepakati siapa pun — dan pemiliknya tidak
     * punya cara menebak dari mana angkanya datang.
     */
    const categoryId = await kategoriBaru('baru');
    await belanja(categoryId, 9_000_000, bulanIni());
    await buatAnggaran(categoryId, true);

    const b = await lihat(categoryId, new Date());
    expect(b.carryOver).toBe(0);
    expect(b.limit).toBe(1_000_000);
  });

  it('sebulan kemudian, sisanya menambah amplop', async () => {
    const categoryId = await kategoriBaru('sisa');
    await belanja(categoryId, 700_000, bulanIni());
    await buatAnggaran(categoryId, true);

    const b = await lihat(categoryId, bulanDepan(1));
    expect(b.carryOver).toBe(300_000);
    expect(b.limit).toBe(1_300_000);
  });

  it('bulan yang jebol menipiskan amplop berikutnya', async () => {
    const categoryId = await kategoriBaru('jebol');
    await belanja(categoryId, 1_300_000, bulanIni());
    await buatAnggaran(categoryId, true);

    const b = await lihat(categoryId, bulanDepan(1));
    expect(b.carryOver).toBe(-300_000);
    expect(b.limit).toBe(700_000);
  });

  it('bulan yang tidak dipakai sama sekali membawa seluruh jatahnya', async () => {
    const categoryId = await kategoriBaru('kosong');
    await buatAnggaran(categoryId, true);

    const b = await lihat(categoryId, bulanDepan(1));
    expect(b.carryOver).toBe(1_000_000);
    expect(b.limit).toBe(2_000_000);
  });

  it('berantai melewati dua bulan yang sudah lewat', async () => {
    const categoryId = await kategoriBaru('rantai');
    await belanja(categoryId, 700_000, bulanIni());
    await buatAnggaran(categoryId, true);
    /* Bulan berikutnya jebol: 1.000.000 + 300.000 − 1.500.000 = −200.000 */
    await belanja(categoryId, 1_500_000, bulanDepan(1).getTime());

    const b = await lihat(categoryId, bulanDepan(2));
    expect(b.carryOver).toBe(-200_000);
  });

  it('pengeluaran periode BERJALAN tidak ikut ke bawaan', async () => {
    /* Periode berjalan diukur lewat `spent`. Menghitungnya juga sebagai
       bawaan membuat setiap belanja hari ini memotong amplopnya dua kali. */
    const categoryId = await kategoriBaru('kini');
    await belanja(categoryId, 700_000, bulanIni());
    await buatAnggaran(categoryId, true);
    await belanja(categoryId, 250_000, bulanDepan(1).getTime());

    const b = await lihat(categoryId, bulanDepan(1));
    expect(b.carryOver).toBe(300_000);
    expect(b.spent).toBe(250_000);
    expect(b.limit).toBe(1_300_000);
  });
});

describe('menyalakan dan mematikan', () => {
  it('dapat dinyalakan sesudahnya, tanpa migrasi data', async () => {
    /* Bawaannya dihitung dari transaksi, bukan disimpan — jadi menyalakannya
       hari ini langsung memperlihatkan sisa periode yang sudah lewat. */
    const categoryId = await kategoriBaru('nyala');
    await belanja(categoryId, 400_000, bulanIni());
    const dibuat = await buatAnggaran(categoryId, false);

    const sebelum = await lihat(categoryId, bulanDepan(1));
    expect(sebelum.limit).toBe(1_000_000);

    const dinyalakan = await data<Budget>(
      api(alice, 'PATCH', `/v1/budgets/${dibuat.id}`, { rollover: true }),
    );
    expect(dinyalakan.rollover).toBe(true);

    const sesudah = await lihat(categoryId, bulanDepan(1));
    expect(sesudah.carryOver).toBe(600_000);
    expect(sesudah.limit).toBe(1_600_000);
  });

  it('dimatikan lagi mengembalikan batas ke jatah polos', async () => {
    const categoryId = await kategoriBaru('mati');
    await belanja(categoryId, 400_000, bulanIni());
    const dibuat = await buatAnggaran(categoryId, true);

    await data<Budget>(api(alice, 'PATCH', `/v1/budgets/${dibuat.id}`, { rollover: false }));

    const b = await lihat(categoryId, bulanDepan(1));
    expect(b.rollover).toBe(false);
    expect(b.carryOver).toBe(0);
    expect(b.limit).toBe(1_000_000);
  });

  it('anggaran orang lain tidak dapat disentuh', async () => {
    const bob = await masuk('roll-bob@contoh.id');
    const categoryId = await kategoriBaru('milik-alice');
    const punyaAlice = await buatAnggaran(categoryId, false);

    const res = await api(bob, 'PATCH', `/v1/budgets/${punyaAlice.id}`, { rollover: true });
    expect(res.statusCode).toBe(404);
  });
});
