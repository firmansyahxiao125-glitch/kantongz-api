import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../../../contracts/auth.js';
import type { Transaction, WalletAccount } from '../../../contracts/ledger.js';
import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';

/**
 * G3 — dompet bersama lewat jalur sungguhan.
 *
 * `akses-dompet.test.ts` membuktikan aturannya dan bahwa tidak ada penyelesai
 * kedua. Di sini dibuktikan yang hanya terlihat di jalur nyata: bahwa `lihat`
 * benar-benar tidak dapat menulis, bahwa orang luar tetap tidak melihat
 * apa-apa, dan bahwa mencabut akses benar-benar mencabutnya.
 */

let h: Harness;
let ani = '';
let budi = '';
let citra = '';
let budiId = '';
let dompetAni = '';

const PASSWORD = 'kantongz-sandi-kuat';
const EMAIL = { ani: 'g3-ani@contoh.id', budi: 'g3-budi@contoh.id', citra: 'g3-citra@contoh.id' };

beforeAll(async () => {
  h = await createHarness();
  ani = await masuk(EMAIL.ani);
  const sesiBudi = await masukPenuh(EMAIL.budi);
  budi = sesiBudi.token;
  budiId = sesiBudi.userId;
  citra = await masuk(EMAIL.citra);

  dompetAni = (
    await d<WalletAccount>(api(ani, 'POST', '/v1/accounts', { name: 'Kas Rumah', kind: 'cash' }))
  ).id;
}, 150_000);

afterAll(async () => {
  await h.close();
});

async function masukPenuh(email: string): Promise<{ token: string; userId: string }> {
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
  const sesi = verify.json<{ data: Session }>().data;
  return { token: sesi.tokens.accessToken, userId: sesi.user.id };
}

const masuk = async (email: string): Promise<string> => (await masukPenuh(email)).token;

function api(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

const catat = (token: string, accountId: string): Promise<LightMyRequestResponse> =>
  api(token, 'POST', '/v1/transactions', {
    accountId,
    kind: 'expense',
    amount: 15_000,
    occurredAt: Date.UTC(2026, 7, 3),
    merchant: 'UJI BERBAGI',
  });

describe('G3 · sebelum dibagikan, tidak ada yang berubah', () => {
  it('Budi tidak melihat dompet Ani', async () => {
    const punyaBudi = await d<WalletAccount[]>(api(budi, 'GET', '/v1/accounts'));
    expect(punyaBudi.map((w) => w.id)).not.toContain(dompetAni);
  }, 60_000);

  it('Budi tidak dapat mencatat ke dompet Ani', async () => {
    const res = await catat(budi, dompetAni);
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it('Budi tidak dapat melihat daftar anggota dompet Ani', async () => {
    const res = await api(budi, 'GET', `/v1/accounts/${dompetAni}/shares`);
    expect(res.statusCode).toBe(404);
  }, 60_000);
});

describe('G3 · peran lihat', () => {
  it('Ani membagikan dengan peran lihat', async () => {
    const anggota = await d<{ memberId: string; email: string; role: string }[]>(
      api(ani, 'POST', `/v1/accounts/${dompetAni}/shares`, {
        email: EMAIL.budi,
        role: 'lihat',
      }),
    );

    expect(anggota).toHaveLength(1);
    expect(anggota[0]?.email).toBe(EMAIL.budi);
    expect(anggota[0]?.role).toBe('lihat');
  }, 60_000);

  it('Budi kini MELIHAT dompetnya', async () => {
    const punyaBudi = await d<WalletAccount[]>(api(budi, 'GET', '/v1/accounts'));
    expect(punyaBudi.map((w) => w.id)).toContain(dompetAni);
  }, 60_000);

  it('tetapi TIDAK dapat mencatat — gagal-tertutup', async () => {
    /* Inti peran `lihat`. Sistem yang memberi tulis kepada siapa pun yang
       dapat membaca sedang menganggap "punya akses" sebagai satu hal, dan itu
       persis kesalahan yang dicegah penyelesai tunggal. */
    const res = await catat(budi, dompetAni);
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it('dan TIDAK dapat mengganti nama dompetnya', async () => {
    const res = await api(budi, 'PATCH', `/v1/accounts/${dompetAni}`, { name: 'Diambil Budi' });
    expect(res.statusCode).toBe(404);

    const punyaAni = await d<WalletAccount[]>(api(ani, 'GET', '/v1/accounts'));
    expect(punyaAni.find((w) => w.id === dompetAni)?.name).toBe('Kas Rumah');
  }, 60_000);

  it('dan TIDAK dapat membagikannya lagi kepada orang lain', async () => {
    /* Berbagi yang dapat dirantai membuat pemilik kehilangan jejak siapa saja
       yang melihat pembukuannya. */
    const res = await api(budi, 'POST', `/v1/accounts/${dompetAni}/shares`, {
      email: EMAIL.citra,
      role: 'lihat',
    });
    expect(res.statusCode).toBe(404);
  }, 60_000);
});

describe('G3 · peran catat', () => {
  it('membagikan ulang MENGGANTI perannya, bukan gagal', async () => {
    /* Membalas bentrok memaksa pemilik menghapus lalu menambah lagi hanya
       untuk mengganti peran — dan di antara keduanya ada jendela ketika
       orangnya tidak punya akses sama sekali. */
    const anggota = await d<{ role: string }[]>(
      api(ani, 'POST', `/v1/accounts/${dompetAni}/shares`, {
        email: EMAIL.budi,
        role: 'catat',
      }),
    );

    expect(anggota).toHaveLength(1);
    expect(anggota[0]?.role).toBe('catat');
  }, 60_000);

  it('Budi kini dapat mencatat', async () => {
    const res = await catat(budi, dompetAni);
    expect(res.statusCode).toBe(201);
  }, 60_000);

  it('transaksinya tetap tercatat atas nama Budi, bukan Ani', async () => {
    /* Dompet dibagikan; pembukuan tidak. Transaksi yang berpindah pemilik
       akan muncul di laporan Ani sebagai pengeluarannya sendiri. */
    const punyaBudi = await d<{ items: Transaction[] }>(
      api(budi, 'GET', '/v1/transactions?limit=100'),
    );
    const punyaAni = await d<{ items: Transaction[] }>(
      api(ani, 'GET', '/v1/transactions?limit=100'),
    );

    expect(punyaBudi.items.some((t) => t.merchant === 'UJI BERBAGI')).toBe(true);
    expect(punyaAni.items.some((t) => t.merchant === 'UJI BERBAGI')).toBe(false);
  }, 60_000);

  it('tetap TIDAK dapat mengganti nama dompetnya', async () => {
    const res = await api(budi, 'PATCH', `/v1/accounts/${dompetAni}`, { name: 'Punya Budi' });
    expect(res.statusCode).toBe(404);
  }, 60_000);
});

describe('G3 · orang luar tetap di luar', () => {
  it('Citra tidak melihat apa pun meski Budi anggota', async () => {
    const punyaCitra = await d<WalletAccount[]>(api(citra, 'GET', '/v1/accounts'));
    expect(punyaCitra.map((w) => w.id)).not.toContain(dompetAni);

    expect((await catat(citra, dompetAni)).statusCode).toBe(404);
    expect((await api(citra, 'GET', `/v1/accounts/${dompetAni}/shares`)).statusCode).toBe(404);
  }, 60_000);

  it('membagikan ke alamat yang tidak terdaftar ditolak', async () => {
    const res = await api(ani, 'POST', `/v1/accounts/${dompetAni}/shares`, {
      email: 'tidak-ada@contoh.id',
      role: 'lihat',
    });
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it('membagikan ke diri sendiri ditolak', async () => {
    const res = await api(ani, 'POST', `/v1/accounts/${dompetAni}/shares`, {
      email: EMAIL.ani,
      role: 'catat',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('peran di luar dua yang dikenali ditolak skema', async () => {
    const res = await api(ani, 'POST', `/v1/accounts/${dompetAni}/shares`, {
      email: EMAIL.citra,
      role: 'admin',
    });
    expect(res.statusCode).toBe(422);
  }, 60_000);
});

describe('G3 · mencabut benar-benar mencabut', () => {
  it('sesudah dicabut, Budi tidak melihat dan tidak dapat mencatat', async () => {
    const sisa = await d<unknown[]>(
      api(ani, 'DELETE', `/v1/accounts/${dompetAni}/shares/${budiId}`),
    );
    expect(sisa).toHaveLength(0);

    const punyaBudi = await d<WalletAccount[]>(api(budi, 'GET', '/v1/accounts'));
    expect(punyaBudi.map((w) => w.id)).not.toContain(dompetAni);

    expect((await catat(budi, dompetAni)).statusCode).toBe(404);
  }, 60_000);

  it('transaksi yang SUDAH dicatat Budi tetap miliknya', async () => {
    /* Mencabut akses bukan menghapus riwayat. Transaksi yang lenyap ketika
       berbagi dicabut adalah uang yang hilang dari pembukuan seseorang. */
    const punyaBudi = await d<{ items: Transaction[] }>(
      api(budi, 'GET', '/v1/transactions?limit=100'),
    );
    expect(punyaBudi.items.some((t) => t.merchant === 'UJI BERBAGI')).toBe(true);
  }, 60_000);
});
