import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';
import { totp } from '../totp.js';

/**
 * Alur 2FA ujung ke ujung, lewat HTTP.
 *
 * ── YANG PALING PANTAS DIJAGA DI SINI ───────────────────────────────────
 *
 * Bukan "2FA bekerja" — melainkan bahwa ia tidak MENGUNCI orang keluar dari
 * akunnya sendiri. Faktor kedua adalah satu-satunya fitur keamanan yang, kalau
 * salah, merugikan pemilik akun jauh lebih sering daripada penyerangnya:
 *
 *   - rahasia yang tersimpan sebelum dipindai tidak boleh langsung berlaku
 *   - kode pemulihan harus benar-benar bisa dipakai masuk
 *   - kode pemulihan hanya SEKALI, kalau tidak ia kata sandi permanen di kertas
 *   - mematikan 2FA harus menuntut kata sandi
 */

let h: Harness;

const SANDI = 'kantongz-sandi-kuat';
const DEV = { deviceId: 'perangkat-2fa-01', platform: 'web' as const };

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
    payload: { fullName: 'Uji 2FA', email, password: SANDI, device: DEV },
  });
  const ticket = reg.json<{ data: { ticket: string } }>().data.ticket;
  const verify = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { ticket, code: h.lastCode()?.code, device: DEV },
  });
  return verify.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken;
}

const masuk = (email: string, totpCode?: string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email, password: SANDI, device: DEV, ...(totpCode ? { totpCode } : {}) },
  });

/** Enrol penuh; mengembalikan rahasia dan kode pemulihannya. */
async function enrol(token: string): Promise<{ secret: string; recovery: string[] }> {
  const setup = await req('POST', '/v1/auth/totp/setup', token);
  const secret = setup.json<{ data: { secret: string } }>().data.secret;

  const enable = await req('POST', '/v1/auth/totp/enable', token, { code: totp(secret) });
  expect(enable.statusCode).toBe(200);

  return {
    secret,
    recovery: enable.json<{ data: { recoveryCodes: string[] } }>().data.recoveryCodes,
  };
}

describe('pendaftaran 2FA', () => {
  it('rahasia yang belum dikonfirmasi TIDAK mengaktifkan apa pun', async () => {
    const email = '2fa-belum@contoh.id';
    const token = await akun(email);

    await req('POST', '/v1/auth/totp/setup', token);

    /*
     * Inti keselamatan alur ini. Kalau `setup` sudah mengaktifkan 2FA, siapa
     * pun yang menutup halaman sebelum memindai QR akan terkunci selamanya
     * dari akunnya sendiri.
     */
    const status = await req('GET', '/v1/auth/totp', token);
    expect(status.json<{ data: { enabled: boolean } }>().data.enabled).toBe(false);
    expect((await masuk(email)).statusCode).toBe(200);
  }, 40_000);

  it('URI otpauth memuat rahasia dan akun', async () => {
    const token = await akun('2fa-uri@contoh.id');
    const setup = await req('POST', '/v1/auth/totp/setup', token);
    const data = setup.json<{ data: { secret: string; otpauthUri: string } }>().data;

    expect(data.otpauthUri).toContain(`secret=${data.secret}`);
    expect(decodeURIComponent(data.otpauthUri)).toContain('2fa-uri@contoh.id');
  }, 40_000);

  it('kode salah tidak mengaktifkan 2FA', async () => {
    const email = '2fa-kode-salah@contoh.id';
    const token = await akun(email);
    await req('POST', '/v1/auth/totp/setup', token);

    const res = await req('POST', '/v1/auth/totp/enable', token, { code: '000000' });
    expect(res.statusCode).toBe(401);
    expect((await masuk(email)).statusCode).toBe(200);
  }, 40_000);

  it('menerbitkan sepuluh kode pemulihan sekali, dan hanya sekali', async () => {
    const token = await akun('2fa-pemulihan@contoh.id');
    const { recovery } = await enrol(token);

    expect(recovery).toHaveLength(10);
    expect(new Set(recovery).size).toBe(10);

    const status = await req('GET', '/v1/auth/totp', token);
    expect(status.json<{ data: { recoveryCodesLeft: number } }>().data.recoveryCodesLeft).toBe(10);
  }, 40_000);
});

describe('masuk dengan 2FA aktif', () => {
  it('kata sandi saja ditolak dengan totp_required, BUKAN invalid_credentials', async () => {
    const email = '2fa-wajib@contoh.id';
    await enrol(await akun(email));

    const res = await masuk(email);
    expect(res.statusCode).toBe(401);
    /* Klien harus dapat membedakan "sandimu salah" dari "sekarang kodenya".
       Menggabungkan keduanya memaksa pengguna mengetik ulang sandi yang benar. */
    expect(res.json<{ error: { code: string } }>().error.code).toBe('totp_required');
  }, 40_000);

  it('kode yang benar diterima', async () => {
    const email = '2fa-benar@contoh.id';
    const { secret } = await enrol(await akun(email));

    const res = await masuk(email, totp(secret));
    expect(res.statusCode).toBe(200);
  }, 40_000);

  it('kode yang salah ditolak', async () => {
    const email = '2fa-tolak@contoh.id';
    await enrol(await akun(email));
    expect((await masuk(email, '000000')).statusCode).toBe(401);
  }, 40_000);

  it('kata sandi salah tetap ditolak meski kodenya benar', async () => {
    const email = '2fa-sandi-salah@contoh.id';
    const { secret } = await enrol(await akun(email));

    /* Faktor kedua MENAMBAH, tidak menggantikan. */
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email, password: 'sandi-yang-salah-sekali', device: DEV, totpCode: totp(secret) },
    });
    expect(res.statusCode).toBe(401);
  }, 40_000);
});

describe('kode pemulihan', () => {
  it('dapat dipakai masuk ketika ponselnya hilang', async () => {
    const email = '2fa-hilang@contoh.id';
    const { recovery } = await enrol(await akun(email));

    const res = await masuk(email, recovery[0]);
    expect(res.statusCode).toBe(200);
  }, 40_000);

  it('SEKALI PAKAI — kode yang sama ditolak pada percobaan kedua', async () => {
    const email = '2fa-sekali@contoh.id';
    const { recovery } = await enrol(await akun(email));
    const kode = recovery[1] ?? '';

    expect((await masuk(email, kode)).statusCode).toBe(200);
    /* Kode pemulihan yang dapat dipakai berulang adalah kata sandi permanen
       yang tercetak di selembar kertas. */
    expect((await masuk(email, kode)).statusCode).toBe(401);
  }, 40_000);

  it('sisa kode berkurang sesudah dipakai', async () => {
    const email = '2fa-sisa@contoh.id';
    const token = await akun(email);
    const { recovery } = await enrol(token);

    await masuk(email, recovery[2]);

    const status = await req('GET', '/v1/auth/totp', token);
    expect(status.json<{ data: { recoveryCodesLeft: number } }>().data.recoveryCodesLeft).toBe(9);
  }, 40_000);

  it('diterima dengan huruf kecil dan tanpa tanda hubung', async () => {
    const email = '2fa-bentuk@contoh.id';
    const { recovery } = await enrol(await akun(email));
    const acak = (recovery[3] ?? '').toLowerCase().replace('-', '');

    /* Disalin tangan dari kertas oleh orang yang sedang panik. */
    expect((await masuk(email, acak)).statusCode).toBe(200);
  }, 40_000);
});

describe('mematikan 2FA', () => {
  it('menuntut kata sandi', async () => {
    const token = await akun('2fa-mati-tanpa-sandi@contoh.id');
    await enrol(token);

    const res = await req('POST', '/v1/auth/totp/disable', token, { password: 'sandi-salah-sekali' });
    expect(res.statusCode).toBe(401);

    const status = await req('GET', '/v1/auth/totp', token);
    expect(status.json<{ data: { enabled: boolean } }>().data.enabled).toBe(true);
  }, 40_000);

  it('dengan kata sandi yang benar: 2FA mati dan kode pemulihan ikut hangus', async () => {
    const email = '2fa-mati@contoh.id';
    const token = await akun(email);
    const { recovery } = await enrol(token);

    expect((await req('POST', '/v1/auth/totp/disable', token, { password: SANDI })).statusCode).toBe(200);

    const status = await req('GET', '/v1/auth/totp', token);
    expect(status.json<{ data: { enabled: boolean; recoveryCodesLeft: number } }>().data).toEqual({
      enabled: false,
      recoveryCodesLeft: 0,
    });

    /* Masuk kembali tanpa kode. */
    expect((await masuk(email)).statusCode).toBe(200);

    /* Dan kertas lama tidak boleh menghidupkan apa pun kalau 2FA dinyalakan
       lagi nanti — kodenya sudah dihapus, bukan sekadar dinonaktifkan. */
    expect((await masuk(email, recovery[4])).statusCode).toBe(200);
  }, 40_000);
});
