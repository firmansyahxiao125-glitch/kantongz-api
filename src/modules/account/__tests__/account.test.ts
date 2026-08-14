import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';

/**
 * Hak pengguna atas datanya sendiri: mengunduh, dan pergi.
 *
 * ── DUA HAL YANG PALING PANTAS DIJAGA ───────────────────────────────────
 *
 * 1. Ekspor TIDAK BOLEH memuat bahan kunci. Berkas ekspor lebih mudah bocor
 *    daripada basis data — ia dikirim lewat email, mengendap di folder Unduhan,
 *    ikut tersalin ke awan. Hash sandi atau rahasia TOTP di dalamnya mengubah
 *    kebocoran satu berkas menjadi pengambilalihan akun.
 *
 * 2. Menutup akun harus BENAR-BENAR menutup: sesi dicabut, masuk ditolak, dan
 *    alamat email bebas dipakai lagi. Penutupan yang menyisakan token hidup
 *    adalah penutupan yang hanya terlihat terjadi.
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
  method: 'GET' | 'POST',
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

async function akun(email: string): Promise<string> {
  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { fullName: 'Uji Akun', email, password: SANDI, device: DEVICE },
  });
  const ticket = reg.json<{ data: { ticket: string } }>().data.ticket;
  const verify = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { ticket, code: h.lastCode()?.code, device: DEVICE },
  });
  return verify.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken;
}

const masuk = (email: string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email, password: SANDI, device: DEVICE },
  });

describe('ekspor data', () => {
  it('memuat data yang dimasukkan pengguna', async () => {
    const email = 'ekspor-isi@contoh.id';
    const token = await akun(email);

    const dompet = await req('POST', '/v1/accounts', token, {
      name: 'Dompet Ekspor', kind: 'cash', openingBalance: 1_000_000,
    });
    const kategori = (
      await req('GET', '/v1/categories', token)
    ).json<{ data: { id: string; kind: string }[] }>().data.find((c) => c.kind === 'expense');

    await req('POST', '/v1/transactions', token, {
      accountId: dompet.json<{ data: { id: string } }>().data.id,
      kind: 'expense', amount: 25_000, categoryId: kategori?.id,
      occurredAt: Date.now(), merchant: 'Warung Ekspor',
    });

    const res = await req('GET', '/v1/account/export', token);
    expect(res.statusCode).toBe(200);

    const data = res.json<{
      data: {
        schemaVersion: number;
        account: { email: string };
        wallets: unknown[];
        transactions: { merchant: string | null }[];
      };
    }>().data;

    expect(data.schemaVersion).toBe(1);
    expect(data.account.email).toBe(email);
    expect(data.wallets).toHaveLength(1);
    expect(data.transactions.some((t) => t.merchant === 'Warung Ekspor')).toBe(true);
  }, 40_000);

  /* INTI KEAMANAN BERKAS INI. */
  it('TIDAK PERNAH memuat bahan kunci', async () => {
    const token = await akun('ekspor-rahasia@contoh.id');

    /* 2FA dinyalakan supaya rahasia TOTP dan kode pemulihan benar-benar ADA
       untuk bisa bocor. Menguji ketiadaan pada akun yang tidak punya rahasia
       tidak membuktikan apa pun. */
    const setup = await req('POST', '/v1/auth/totp/setup', token);
    expect(setup.statusCode).toBe(200);

    const res = await req('GET', '/v1/account/export', token);
    expect(res.body).not.toMatch(/passwordHash|password_hash|\$argon2/i);
    expect(res.body).not.toMatch(/totpSecret|totp_secret|recoveryCode|deviceHash|device_hash/i);
    expect(res.body).not.toMatch(/refreshToken|refresh_token/i);
  }, 40_000);

  it('dikirim sebagai unduhan, bukan halaman', async () => {
    const token = await akun('ekspor-unduh@contoh.id');
    const res = await req('GET', '/v1/account/export', token);
    /* Berkas yang terbuka sebagai halaman JSON di tab adalah berkas yang tidak
       pernah tersimpan — dan penggunanya mengira sudah. */
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="kantongz-/);
  }, 40_000);

  it('menolak tanpa token', async () => {
    expect((await req('GET', '/v1/account/export')).statusCode).toBe(401);
  });
});

describe('menutup akun', () => {
  it('menuntut kata sandi', async () => {
    const email = 'tutup-tanpa-sandi@contoh.id';
    const token = await akun(email);

    const res = await req('POST', '/v1/account/close', token, { password: 'sandi-yang-salah' });
    expect(res.statusCode).toBe(401);

    /* Dan akunnya HARUS masih hidup. */
    expect((await masuk(email)).statusCode).toBe(200);
  }, 40_000);

  it('menutup: masuk ditolak, dan sesi tidak dapat diperpanjang', async () => {
    const email = 'tutup-berhasil@contoh.id';

    /* Refresh token disimpan supaya dapat diuji SESUDAH penutupan. */
    const reg = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { fullName: 'Uji Akun', email, password: SANDI, device: DEVICE },
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
    const tokens = verify.json<{ data: { tokens: { accessToken: string; refreshToken: string } } }>()
      .data.tokens;

    expect(
      (await req('POST', '/v1/account/close', tokens.accessToken, { password: SANDI })).statusCode,
    ).toBe(200);

    /* Tidak bisa masuk lagi. */
    expect((await masuk(email)).statusCode).toBeGreaterThanOrEqual(400);

    /*
     * Dan sesi TIDAK DAPAT DIPERPANJANG — inilah batas yang benar-benar
     * dijanjikan sistem ini.
     *
     * CATATAN JUJUR: access token yang SUDAH terbit tetap sah sampai
     * kedaluwarsa, hingga sepuluh menit. Itu bukan cacat melainkan keputusan
     * yang tertulis di `tokens/jwt.ts` dan M3_SPEC §10 — token stateless
     * dipilih justru supaya tidak ada kueri sesi pada setiap permintaan, dan
     * harganya adalah jendela pencabutan selebar umur token.
     *
     * Percobaan pertama uji ini menegaskan access token langsung mati, dan itu
     * menuntut jaminan yang memang tidak pernah diberikan. Yang ditegakkan
     * sekarang adalah kontrak yang sebenarnya.
     */
    const refresh = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: tokens.refreshToken, device: DEVICE },
    });
    expect(refresh.statusCode).toBeGreaterThanOrEqual(400);
  }, 40_000);

  it('membebaskan alamat email untuk didaftarkan lagi', async () => {
    const email = 'tutup-daftar-lagi@contoh.id';
    const token = await akun(email);
    await req('POST', '/v1/account/close', token, { password: SANDI });

    /* Indeks unik `users_email_active` sengaja mengecualikan baris terhapus.
       Orang yang berubah pikiran harus dapat kembali. */
    const lagi = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { fullName: 'Kembali', email, password: SANDI, device: DEVICE },
    });
    expect(lagi.statusCode).toBe(201);
  }, 40_000);
});
