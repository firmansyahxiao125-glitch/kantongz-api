import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEVICE, createHarness, type Harness } from '../../modules/auth/__tests__/harness.js';

/**
 * Kode status untuk permintaan yang SALAH.
 *
 * ── MENGAPA BERKAS INI ADA ──────────────────────────────────────────────
 *
 * Dua cacat hidup berdampingan di produksi tanpa satu pun uji menyadarinya,
 * dan keduanya berbentuk sama: `openapi.json` menjanjikan 4xx, implementasinya
 * mengembalikan 500.
 *
 *   POST /v1/auth/sign-in   badan cacat  -> 500  (dijanjikan 422)
 *   POST /v1/budgets        duplikat     -> 500  (dijanjikan 409)
 *   POST /v1/accounts       duplikat     -> 500  (dijanjikan 409)
 *   POST /v1/categories     duplikat     -> 500  (dijanjikan 409)
 *
 * Uji yang ada sudah menutupi 422 dan 409 — tetapi hanya untuk aturan DOMAIN
 * (`weak_password`, `email_taken`), yang tercapai SESUDAH skema lolos. Tidak
 * satu pun mengirim badan yang gagal di skema, dan tidak satu pun menabrakkan
 * dua baris pada indeks unik. Celah itu yang membuat kedua cacat bertahan.
 *
 * PGlite adalah PostgreSQL sungguhan, jadi indeks unik di sini benar-benar
 * ditegakkan — bukan ditiru.
 *
 * ── YANG DIJAGA ─────────────────────────────────────────────────────────
 *
 * 500 berarti "kami rusak". Mengembalikannya untuk masukan yang salah membuat
 * klien mengulang permintaan yang tidak akan pernah berhasil, dan menaikkan
 * angka 5xx yang seharusnya hanya berbunyi ketika kesalahan memang milik kita.
 */

let h: Harness;

const SANDI = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

function post(
  url: string,
  payload: unknown,
  token?: string,
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
}

const kode = (res: LightMyRequestResponse): string =>
  res.json<{ error?: { code?: string } }>().error?.code ?? 'ok';

/** Sesi sungguhan: daftar, ambil kode dari "kotak masuk" harness, verifikasi. */
async function sesi(email: string): Promise<string> {
  const reg = await post('/v1/auth/register', {
    fullName: 'Uji Status',
    email,
    password: SANDI,
    device: DEVICE,
  });
  const ticket = reg.json<{ data: { ticket: string } }>().data.ticket;
  const verify = await post('/v1/auth/verify', {
    ticket,
    code: h.lastCode()?.code,
    device: DEVICE,
  });
  return verify.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken;
}

describe('badan permintaan auth yang gagal di skema', () => {
  /*
   * `deviceId` di bawah `minLength` adalah kasus yang benar-benar ditemukan di
   * runtime, dan yang paling mudah dikirim klien sungguhan: satu perangkat
   * dengan id pendek membuat SETIAP permintaan masuknya dijawab "kesalahan
   * server".
   */
  const kasus: [string, string, Record<string, unknown>][] = [
    [
      'sign-in: deviceId lebih pendek dari minimum',
      '/v1/auth/sign-in',
      { email: 'a@contoh.id', password: SANDI, device: { deviceId: 'abc', platform: 'web' } },
    ],
    ['sign-in: badan kosong', '/v1/auth/sign-in', {}],
    [
      'sign-in: device tidak disertakan',
      '/v1/auth/sign-in',
      { email: 'a@contoh.id', password: SANDI },
    ],
    [
      'register: email bukan email',
      '/v1/auth/register',
      { fullName: 'X', email: 'bukan-email', password: SANDI, device: DEVICE },
    ],
    [
      'register: platform di luar enum',
      '/v1/auth/register',
      {
        fullName: 'X',
        email: 'a@contoh.id',
        password: SANDI,
        device: { deviceId: 'device-uji-0002', platform: 'pesawat' },
      },
    ],
    [
      'verify: kode lebih pendek dari minimum',
      '/v1/auth/verify',
      { ticket: 'tkt_x', code: '1', device: DEVICE },
    ],
    [
      'refresh: token lebih pendek dari minimum',
      '/v1/auth/refresh',
      { refreshToken: 'pendek', device: DEVICE },
    ],
  ];

  for (const [nama, url, payload] of kasus) {
    it(`${nama} -> 422 invalid_input`, async () => {
      const res = await post(url, payload);
      expect(res.statusCode).toBe(422);
      expect(kode(res)).toBe('invalid_input');
    });
  }

  it('pesannya tidak menyebut kolom mana pun yang gagal', async () => {
    /* Kalimatnya sengaja tumpul: pesan validasi yang menyebut nama kolom
       memberi peta API kepada siapa pun yang menebak-nebak. */
    const res = await post('/v1/auth/sign-in', {});
    const pesan = res.json<{ error: { message: string } }>().error.message;
    expect(pesan).not.toMatch(/deviceId|password|email|platform/i);
  });
});

describe('pelanggaran indeks unik menjadi 409, bukan 500', () => {
  it('dompet dengan nama yang sudah dipakai', async () => {
    const token = await sesi('konflik-dompet@contoh.id');
    const body = { name: 'Dompet Kembar', kind: 'cash' };

    expect((await post('/v1/accounts', body, token)).statusCode).toBe(201);

    const kedua = await post('/v1/accounts', body, token);
    expect(kedua.statusCode).toBe(409);
    expect(kode(kedua)).toBe('conflict');
  }, 30_000);

  it('kategori dengan nama dan jenis yang sudah dipakai', async () => {
    const token = await sesi('konflik-kategori@contoh.id');
    const body = { name: 'Kategori Kembar', kind: 'expense', icon: 'circle-dashed', color: '#7f7f8b' };

    expect((await post('/v1/categories', body, token)).statusCode).toBe(201);

    const kedua = await post('/v1/categories', body, token);
    expect(kedua.statusCode).toBe(409);
    expect(kode(kedua)).toBe('conflict');
  }, 30_000);

  it('anggaran kedua untuk kategori yang sudah punya anggaran aktif', async () => {
    const token = await sesi('konflik-anggaran@contoh.id');
    const kategori = await h.app.inject({
      method: 'GET',
      url: '/v1/categories',
      headers: { authorization: `Bearer ${token}` },
    });
    const pengeluaran = kategori
      .json<{ data: { id: string; kind: string }[] }>()
      .data.find((c) => c.kind === 'expense');
    expect(pengeluaran).toBeDefined();

    const body = { categoryId: pengeluaran?.id, amount: 500_000, period: 'monthly' };
    expect((await post('/v1/budgets', body, token)).statusCode).toBe(201);

    const kedua = await post('/v1/budgets', body, token);
    expect(kedua.statusCode).toBe(409);
    expect(kode(kedua)).toBe('conflict');
  }, 30_000);

  it('pesan konflik tidak membocorkan nama tabel atau SQL', async () => {
    const token = await sesi('konflik-bocor@contoh.id');
    const body = { name: 'Dompet Bocor', kind: 'cash' };
    await post('/v1/accounts', body, token);
    const kedua = await post('/v1/accounts', body, token);

    expect(kedua.body).not.toMatch(/wallet_accounts|insert into|drizzle|postgres|23505/i);
  }, 30_000);
});
