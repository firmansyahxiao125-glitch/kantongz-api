import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEVICE, createHarness, type Harness } from './harness.js';

/**
 * Daftar sesi aktif, dan pengakhiran satu sesi.
 *
 * ── YANG DIJAGA ─────────────────────────────────────────────────────────
 *
 * Rotasi refresh token dan deteksi pemakaian ulang sudah bekerja sejak lama,
 * dan seluruhnya tidak terlihat pengguna. Dua rute ini yang membuatnya dapat
 * ditindak — dan begitu sebuah rute dapat MENGAKHIRI sesi, ia menjadi sasaran
 * yang menarik. Berkas ini menjaga dua hal sekaligus:
 *
 *   1. daftarnya benar dan menandai sesi yang sedang dipakai
 *   2. sesi milik orang lain TIDAK dapat disentuh, dan penolakannya tidak
 *      membocorkan bahwa id yang ditebak itu ada
 */

let h: Harness;

const SANDI = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

function req(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token?: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** Satu perangkat berbeda per pemanggilan — sesi terikat pada perangkat. */
function device(n: string) {
  return { deviceId: `perangkat-uji-${n}`, platform: 'web' as const };
}

async function daftar(email: string, dev: { deviceId: string; platform: 'web' }) {
  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { fullName: 'Uji Sesi', email, password: SANDI, device: dev },
  });
  const ticket = reg.json<{ data: { ticket: string } }>().data.ticket;
  const verify = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { ticket, code: h.lastCode()?.code, device: dev },
  });
  return verify.json<{ data: { tokens: { accessToken: string; refreshToken: string } } }>().data
    .tokens;
}

/** Sesi KEDUA untuk pengguna yang sama, dari perangkat lain. */
async function masukLagi(email: string, dev: { deviceId: string; platform: 'web' }) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email, password: SANDI, device: dev },
  });
  return res.json<{ data: { tokens: { accessToken: string } } }>().data.tokens;
}

describe('daftar sesi aktif', () => {
  it('memuat setiap sesi terbuka dan menandai HANYA yang sedang dipakai', async () => {
    const email = 'sesi-daftar@contoh.id';
    const a = await daftar(email, device('a1'));
    const b = await masukLagi(email, device('a2'));

    const dariA = await req('GET', '/v1/auth/sessions', a.accessToken);
    expect(dariA.statusCode).toBe(200);

    const sesi = dariA.json<{
      data: { id: string; current: boolean; platform: string; lastSeenAt: number }[];
    }>().data;

    expect(sesi).toHaveLength(2);
    /* Tepat SATU ditandai `current`. Dua penanda membuat antarmuka menyarankan
       pengguna mengakhiri sesinya sendiri; nol penanda membuatnya tidak berani
       mengakhiri apa pun. */
    expect(sesi.filter((s) => s.current)).toHaveLength(1);
    expect(sesi.every((s) => s.platform === 'web')).toBe(true);

    /* Dilihat dari token B, yang `current` harus BERGESER ke sesi B. */
    const dariB = await req('GET', '/v1/auth/sessions', b.accessToken);
    const sesiB = dariB.json<{ data: { id: string; current: boolean }[] }>().data;
    const currentA = sesi.find((s) => s.current)?.id;
    const currentB = sesiB.find((s) => s.current)?.id;
    expect(currentB).toBeDefined();
    expect(currentB).not.toBe(currentA);
  }, 40_000);

  it('tidak pernah membocorkan token atau hash perangkat', async () => {
    const a = await daftar('sesi-bocor@contoh.id', device('b1'));
    const res = await req('GET', '/v1/auth/sessions', a.accessToken);
    /* Daftar yang memuat token justru menjadikan halaman keamanan sebagai
       tempat termudah mencuri sesi. */
    expect(res.body).not.toMatch(/deviceHash|refreshToken|accessToken|hmac/i);
  }, 40_000);

  it('menolak tanpa token', async () => {
    expect((await req('GET', '/v1/auth/sessions')).statusCode).toBe(401);
  });
});

describe('mengakhiri satu sesi', () => {
  it('sesi yang diakhiri hilang dari daftar, dan sisanya tetap hidup', async () => {
    const email = 'sesi-akhiri@contoh.id';
    const a = await daftar(email, device('c1'));
    await masukLagi(email, device('c2'));

    const sebelum = (
      await req('GET', '/v1/auth/sessions', a.accessToken)
    ).json<{ data: { id: string; current: boolean }[] }>().data;
    const lain = sebelum.find((s) => !s.current);
    expect(lain).toBeDefined();

    const hapus = await req('DELETE', `/v1/auth/sessions/${lain?.id ?? ''}`, a.accessToken);
    expect(hapus.statusCode).toBe(200);

    const sesudah = (
      await req('GET', '/v1/auth/sessions', a.accessToken)
    ).json<{ data: { id: string }[] }>().data;
    expect(sesudah).toHaveLength(1);
    expect(sesudah.some((s) => s.id === lain?.id)).toBe(false);
  }, 40_000);

  it('refresh token sesi yang diakhiri ikut MATI', async () => {
    const email = 'sesi-token-mati@contoh.id';
    const a = await daftar(email, device('d1'));
    const b = await daftar('sesi-token-mati-lain@contoh.id', device('d2'));
    void b;

    /* Sesi A mengakhiri DIRINYA SENDIRI. Yang diuji: menutup baris sesi saja
       tidak cukup — kalau keluarga refresh token-nya tidak ikut dicabut,
       sesi yang "diakhiri" masih dapat menerbitkan akses baru selamanya. */
    const daftarA = (
      await req('GET', '/v1/auth/sessions', a.accessToken)
    ).json<{ data: { id: string; current: boolean }[] }>().data;
    const sendiri = daftarA.find((s) => s.current);

    expect((await req('DELETE', `/v1/auth/sessions/${sendiri?.id ?? ''}`, a.accessToken)).statusCode).toBe(200);

    const refresh = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: a.refreshToken, device: device('d1') },
    });
    expect(refresh.statusCode).toBeGreaterThanOrEqual(400);
  }, 40_000);

  /*
   * INTI KEAMANAN BERKAS INI.
   *
   * Tanpa pemeriksaan kepemilikan, rute ini menjadi alat mengeluarkan orang
   * lain dari akunnya sendiri hanya dengan menebak id sesi.
   */
  it('tidak dapat mengakhiri sesi milik pengguna lain', async () => {
    const korban = await daftar('sesi-korban@contoh.id', device('e1'));
    const penyerang = await daftar('sesi-penyerang@contoh.id', device('e2'));

    const sesiKorban = (
      await req('GET', '/v1/auth/sessions', korban.accessToken)
    ).json<{ data: { id: string }[] }>().data;
    const sasaran = sesiKorban[0]?.id ?? '';

    const res = await req('DELETE', `/v1/auth/sessions/${sasaran}`, penyerang.accessToken);
    /* 404, BUKAN 403: membedakan keduanya memberi tahu penebak bahwa id yang
       ia coba benar-benar ada. */
    expect(res.statusCode).toBe(404);

    /* Dan yang terpenting — sesi korban HARUS masih hidup. */
    const masihAda = (
      await req('GET', '/v1/auth/sessions', korban.accessToken)
    ).json<{ data: { id: string }[] }>().data;
    expect(masihAda.some((s) => s.id === sasaran)).toBe(true);
  }, 40_000);

  it('id yang tidak ada dijawab 404, bukan 500', async () => {
    const a = await daftar('sesi-hantu@contoh.id', device('f1'));
    const res = await req('DELETE', '/v1/auth/sessions/ses_tidak_ada_sama_sekali', a.accessToken);
    expect(res.statusCode).toBe(404);
  }, 40_000);
});
