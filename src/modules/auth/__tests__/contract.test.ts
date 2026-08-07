import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEVICE, createHarness, type Harness } from './harness.js';

/**
 * Uji kontrak. M3_SPEC §17 dan §18.
 *
 * Yang diuji bukan apakah nilainya benar — itu tugas uji integrasi. Yang diuji
 * adalah BENTUKNYA: kunci apa saja yang keluar, dan yang lebih penting, kunci
 * apa saja yang TIDAK keluar.
 *
 * Kebocoran bentuk adalah cara paling sunyi data internal keluar. Satu
 * `SELECT *` yang lolos tinjauan mengirim `password_hash`, `email_hash`, dan
 * `status` ke setiap klien, dan tidak ada satu pun uji nilai yang akan
 * menyadarinya karena seluruh nilainya memang benar.
 */

let h: Harness;

const PASSWORD = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

function post(url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: 'POST', url, payload });
}

/** Kunci sebuah objek, terurut — supaya kegagalan menampilkan selisih yang
 *  dapat dibaca alih-alih dua objek besar. */
function keysOf(value: unknown): string[] {
  return typeof value === 'object' && value !== null ? Object.keys(value).sort() : [];
}

async function sessionOf(email: string) {
  const reg = await post('/v1/auth/register', {
    fullName: 'Kontrak Uji',
    email,
    password: PASSWORD,
    device: DEVICE,
  });

  const ticket = reg.json<{ data: { ticket: string } }>().data.ticket;
  const verify = await post('/v1/auth/verify', {
    ticket,
    code: h.lastCode()?.code,
    device: DEVICE,
  });

  return verify;
}

describe('amplop', () => {
  it('setiap respons sukses berbentuk { data, meta }', async () => {
    const res = await sessionOf('kontrak-amplop@contoh.id');
    const body = res.json<Record<string, unknown>>();

    expect(keysOf(body)).toEqual(['data', 'meta']);
    expect(keysOf(body.meta)).toEqual(['requestId']);
  }, 60_000);

  it('setiap respons galat berbentuk { error, meta } dengan empat kunci galat', async () => {
    const res = await post('/v1/auth/sign-in', {
      email: 'tidak-ada@contoh.id',
      password: 'apa-pun-yang-panjang',
      device: DEVICE,
    });

    const body = res.json<Record<string, unknown>>();
    expect(keysOf(body)).toEqual(['error', 'meta']);
    expect(keysOf(body.error)).toEqual(['code', 'details', 'message', 'retryAfter']);
  }, 30_000);

  it('requestId dikembalikan juga sebagai header, dan nilainya sama', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/livez' });
    const body = res.json<{ meta: { requestId: string } }>();

    expect(res.headers['x-request-id']).toBe(body.meta.requestId);
  });
});

describe('bentuk Session', () => {
  it('memuat tepat user dan tokens, tanpa kunci lain', async () => {
    const res = await sessionOf('kontrak-sesi@contoh.id');
    const data = res.json<{ data: Record<string, unknown> }>().data;

    expect(keysOf(data)).toEqual(['tokens', 'user']);
  }, 60_000);

  /*
   * INI uji yang paling penting di berkas ini. `users` punya `passwordHash`,
   * `emailHash`, `emailEncrypted`, `status`, dan `hmacKeyVersion`. Tidak satu
   * pun boleh menyeberang, dan satu `SELECT *` yang lolos tinjauan akan
   * mengirim semuanya tanpa satu pun uji nilai menyadarinya.
   */
  it('User memuat tepat id, email, fullName — tidak lebih', async () => {
    const res = await sessionOf('kontrak-user@contoh.id');
    const user = res.json<{ data: { user: Record<string, unknown> } }>().data.user;

    expect(keysOf(user)).toEqual(['email', 'fullName', 'id']);

    const serialised = JSON.stringify(user);
    for (const bocor of ['passwordHash', 'password_hash', 'emailHash', 'status', 'deletedAt']) {
      expect(serialised, bocor).not.toContain(bocor);
    }
  }, 60_000);

  it('AuthTokens memuat tepat tiga kunci, dan kedaluwarsa berupa epoch milidetik', async () => {
    const res = await sessionOf('kontrak-token@contoh.id');
    const tokens = res.json<{ data: { tokens: Record<string, unknown> } }>().data.tokens;

    expect(keysOf(tokens)).toEqual(['accessToken', 'accessTokenExpiresAt', 'refreshToken']);
    expect(typeof tokens.accessTokenExpiresAt).toBe('number');
    /* Absolut, bukan durasi — supaya tetap benar setelah aplikasi ditutup
       berjam-jam. Nilai di bawah tahun 2001 berarti seseorang mengirim detik. */
    expect(tokens.accessTokenExpiresAt as number).toBeGreaterThan(1_000_000_000_000);
  }, 60_000);
});

describe('bentuk PendingVerification', () => {
  it('memuat tepat ticket, maskedEmail, codeLength', async () => {
    const res = await post('/v1/auth/register', {
      fullName: 'Kontrak Tunda',
      email: 'kontrak-tunda@contoh.id',
      password: PASSWORD,
      device: DEVICE,
    });

    expect(keysOf(res.json<{ data: unknown }>().data)).toEqual([
      'codeLength',
      'maskedEmail',
      'ticket',
    ]);
  }, 60_000);

  /* Kode TIDAK PERNAH ikut di respons — ia berangkat lewat outbox ke email. */
  it('tidak pernah membawa kodenya sendiri', async () => {
    const res = await post('/v1/auth/register', {
      fullName: 'Kontrak Kode',
      email: 'kontrak-kode@contoh.id',
      password: PASSWORD,
      device: DEVICE,
    });

    const body = res.body;
    const code = h.lastCode()?.code;
    expect(code).toBeTruthy();
    expect(body).not.toContain(code);
  }, 60_000);

  it('maskedEmail menyamarkan bagian lokal tetapi mempertahankan domain', async () => {
    const res = await post('/v1/auth/password/forgot', { email: 'panjangsekali@contoh.id' });
    const masked = res.json<{ data: { maskedEmail: string } }>().data.maskedEmail;

    expect(masked).toContain('@contoh.id');
    expect(masked).not.toContain('panjangsekali');
    expect(masked.startsWith('p')).toBe(true);
  }, 30_000);
});

describe('bentuk rotasi', () => {
  it('refresh mengembalikan tepat tiga kunci token, tanpa user', async () => {
    const res = await sessionOf('kontrak-rotasi@contoh.id');
    const tokens = res.json<{ data: { tokens: { refreshToken: string } } }>().data.tokens;

    const rotated = await post('/v1/auth/refresh', {
      refreshToken: tokens.refreshToken,
      device: DEVICE,
    });

    /* Tanpa `user`: rotasi bukan tempat mengirim ulang profil, dan mengirimnya
       membuat setiap penyegaran membaca tabel yang tidak perlu dibaca. */
    expect(keysOf(rotated.json<{ data: unknown }>().data)).toEqual([
      'accessToken',
      'accessTokenExpiresAt',
      'refreshToken',
    ]);
  }, 60_000);
});

describe('klaim JWT', () => {
  /* §4.2 — tidak ada email, nama, atau saldo di dalam klaim. JWT dapat dibaca
     siapa pun yang memegangnya; klaim adalah tempat data pribadi paling mudah
     bocor tanpa siapa pun menyadarinya. */
  it('memuat hanya sub, sid, did, rol — dan tidak ada data pribadi', async () => {
    const res = await sessionOf('kontrak-klaim@contoh.id');
    const token = res.json<{ data: { tokens: { accessToken: string } } }>().data.tokens
      .accessToken;

    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;

    /* Klaim terdaftar RFC 7519 disaring: keduanya struktural, bukan data
       pribadi. `jti` khususnya diperlukan agar satu token dapat dirujuk di
       jejak audit tanpa mencatat tokennya sendiri. */
    const REGISTERED = ['iat', 'exp', 'iss', 'aud', 'nbf', 'jti'];

    expect(keysOf(claims).filter((k) => !REGISTERED.includes(k))).toEqual([
      'did',
      'rol',
      'sid',
      'sub',
    ]);

    const serialised = JSON.stringify(claims);
    expect(serialised).not.toContain('kontrak-klaim');
    expect(serialised).not.toContain('@contoh.id');
  }, 60_000);
});

describe('status HTTP', () => {
  it('memetakan setiap kode kontrak ke status yang ditetapkan §18', async () => {
    const kasus: { deskripsi: string; jalankan: () => Promise<LightMyRequestResponse>; status: number }[] =
      [
        {
          deskripsi: 'invalid_credentials → 401',
          jalankan: () =>
            post('/v1/auth/sign-in', {
              email: 'status-401@contoh.id',
              password: 'sandi-yang-panjang',
              device: DEVICE,
            }),
          status: 401,
        },
        {
          deskripsi: 'weak_password → 422',
          jalankan: () =>
            post('/v1/auth/register', {
              fullName: 'Lemah',
              email: 'status-422@contoh.id',
              password: 'pendek',
              device: DEVICE,
            }),
          status: 422,
        },
        {
          deskripsi: 'invalid_code → 401',
          jalankan: () =>
            post('/v1/auth/verify', { ticket: 'tkt_asing', code: '000000', device: DEVICE }),
          status: 401,
        },
        {
          deskripsi: 'session_expired → 401',
          jalankan: () =>
            post('/v1/auth/refresh', { refreshToken: 'token-asing-sekali', device: DEVICE }),
          status: 401,
        },
      ];

    for (const k of kasus) {
      const res = await k.jalankan();
      expect(res.statusCode, k.deskripsi).toBe(k.status);
    }
  }, 60_000);

  it('email_taken → 409', async () => {
    await sessionOf('status-409@contoh.id');

    const res = await post('/v1/auth/register', {
      fullName: 'Kembar',
      email: 'status-409@contoh.id',
      password: PASSWORD,
      device: DEVICE,
    });

    expect(res.statusCode).toBe(409);
  }, 60_000);

  it('rate_limited → 429 dengan header retry-after', async () => {
    const email = 'status-429@contoh.id';
    await sessionOf(email);

    let res: LightMyRequestResponse | null = null;
    for (let i = 0; i < 5; i += 1) {
      res = await post('/v1/auth/sign-in', { email, password: 'salah-terus', device: DEVICE });
    }

    expect(res?.statusCode).toBe(429);
    expect(res?.headers['retry-after']).toBeDefined();
    expect(Number(res?.headers['retry-after'])).toBeGreaterThan(0);
  }, 120_000);
});

describe('galat validasi', () => {
  /* Pesan validasi membocorkan bentuk API kepada siapa pun yang menebak. Yang
     keluar hanya kode generik. */
  it('badan yang salah bentuk tidak menjelaskan bentuk yang benar', async () => {
    const res = await post('/v1/auth/sign-in', { email: 'bukan-email' });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const body = res.body.toLowerCase();
    for (const bocor of ['password', 'device', 'deviceid', 'required', 'expected', 'zod']) {
      expect(body, bocor).not.toContain(bocor);
    }
  }, 30_000);
});
