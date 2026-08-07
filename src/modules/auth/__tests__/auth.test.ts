import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../../../contracts/auth.js';
import { verifyAuditChain } from '../../audit/index.js';
import { DEVICE, createHarness, type Harness } from './harness.js';

/**
 * Uji integrasi alur autentikasi terhadap PostgreSQL sungguhan.
 *
 * Yang diuji di sini bukan "apakah kodenya berjalan" melainkan apakah
 * KEPUTUSAN keamanannya benar — urutan pemeriksaan penguncian, ketiadaan
 * enumerasi akun, dan pencabutan keluarga token.
 */

let h: Harness;

const EMAIL = 'orang@contoh.id';
const PASSWORD = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

/* Anotasi kembalian eksplisit: `inject` punya tiga kelebihan beban, dan tanpa
   tipe ini TypeScript memilih irisan ketiganya alih-alih responsnya. */
function post(url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: 'POST', url, payload });
}

function get(url: string, headers?: Record<string, string>): Promise<LightMyRequestResponse> {
  return h.app.inject(headers ? { method: 'GET', url, headers } : { method: 'GET', url });
}

async function daftarDanVerifikasi(email: string, password = PASSWORD): Promise<Session> {
  const reg = await post('/v1/auth/register', {
    fullName: 'Orang Uji',
    email,
    password,
    device: DEVICE,
  });
  expect(reg.statusCode).toBe(201);

  const pending = reg.json<{ data: { ticket: string } }>().data;
  const code = h.lastCode();
  expect(code?.purpose).toBe('verify');

  const verify = await post('/v1/auth/verify', {
    ticket: pending.ticket,
    code: code?.code,
    device: DEVICE,
  });
  expect(verify.statusCode).toBe(200);
  return verify.json<{ data: Session }>().data;
}

describe('pendaftaran', () => {
  it('membuat akun lalu menghasilkan sesi setelah verifikasi', async () => {
    const session = await daftarDanVerifikasi(EMAIL);
    expect(session.user.email).toBe(EMAIL);
    expect(session.user.fullName).toBe('Orang Uji');
    expect(session.tokens.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  }, 60_000);

  /* §12 — pendaftaran SENGAJA membocorkan bahwa email sudah terpakai. */
  it('menolak email yang sudah terpakai dengan kode yang jelas', async () => {
    const res = await post('/v1/auth/register', {
      fullName: 'Orang Lain',
      email: EMAIL,
      password: PASSWORD,
      device: DEVICE,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('email_taken');
  }, 30_000);

  it('menolak sandi lemah di lapisan layanan, bukan hanya di UI', async () => {
    const res = await post('/v1/auth/register', {
      fullName: 'Orang',
      email: 'lemah@contoh.id',
      password: 'pendek',
      device: DEVICE,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('weak_password');
  }, 30_000);

  it('akun yang belum terverifikasi tidak bisa dipakai masuk', async () => {
    await post('/v1/auth/register', {
      fullName: 'Belum Verif',
      email: 'belum@contoh.id',
      password: PASSWORD,
      device: DEVICE,
    });

    const res = await post('/v1/auth/sign-in', {
      email: 'belum@contoh.id',
      password: PASSWORD,
      device: DEVICE,
    });
    expect(res.statusCode).toBe(401);
  }, 60_000);
});

describe('masuk', () => {
  it('berhasil dengan kredensial yang benar', async () => {
    const res = await post('/v1/auth/sign-in', { email: EMAIL, password: PASSWORD, device: DEVICE });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: Session }>().data.tokens.refreshToken).toBeTruthy();
  }, 30_000);

  it('menolak sandi salah dengan kode yang sama seperti email tak dikenal', async () => {
    const salah = await post('/v1/auth/sign-in', {
      email: EMAIL,
      password: 'sandi-yang-salah',
      device: DEVICE,
    });
    const asing = await post('/v1/auth/sign-in', {
      email: 'tidak-ada@contoh.id',
      password: 'apa-pun-yang-panjang',
      device: DEVICE,
    });

    /* Tidak ada enumerasi akun: kedua jalur menghasilkan kode yang sama. */
    expect(salah.statusCode).toBe(401);
    expect(asing.statusCode).toBe(401);
    expect(salah.json<{ error: { code: string } }>().error.code).toBe('invalid_credentials');
    expect(asing.json<{ error: { code: string } }>().error.code).toBe('invalid_credentials');
  }, 60_000);
});

describe('penguncian', () => {
  const TARGET = 'kunci@contoh.id';

  it('mengunci setelah lima kegagalan dan menahan sandi yang BENAR', async () => {
    await daftarDanVerifikasi(TARGET);

    for (let i = 0; i < 5; i += 1) {
      await post('/v1/auth/sign-in', {
        email: TARGET,
        password: 'salah-terus-menerus',
        device: DEVICE,
      });
    }

    const benar = await post('/v1/auth/sign-in', {
      email: TARGET,
      password: PASSWORD,
      device: DEVICE,
    });

    /* §13 — penguncian diperiksa SEBELUM kredensial dibandingkan. Penguncian
       yang masih menerima sandi benar bukan penguncian. */
    expect(benar.statusCode).toBe(429);
    expect(benar.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
    expect(benar.headers['retry-after']).toBeDefined();
  }, 120_000);

  it('mencatat kegagalan juga untuk email yang tidak terdaftar', async () => {
    const asing = 'hantu-terkunci@contoh.id';
    for (let i = 0; i < 5; i += 1) {
      await post('/v1/auth/sign-in', { email: asing, password: 'salah-sekali', device: DEVICE });
    }

    const res = await post('/v1/auth/sign-in', {
      email: asing,
      password: 'salah-sekali',
      device: DEVICE,
    });

    /* Kalau hanya email terdaftar yang dihitung, selisih perilaku itu sendiri
       menjadi oracle yang membocorkan alamat mana yang ada. */
    expect(res.statusCode).toBe(429);
  }, 120_000);
});

describe('pemulihan sandi', () => {
  it('selalu 200 untuk email yang TIDAK terdaftar, dengan tiket hantu', async () => {
    const res = await post('/v1/auth/password/forgot', { email: 'sama-sekali-asing@contoh.id' });
    expect(res.statusCode).toBe(200);

    const data = res.json<{ data: { ticket: string; maskedEmail: string } }>().data;
    expect(data.ticket).toBeTruthy();
    expect(data.maskedEmail).toContain('@');

    /* Tiket hantu tidak pernah bisa ditukar, dan tidak ada email yang dikirim. */
    const tukar = await post('/v1/auth/password/reset', {
      ticket: data.ticket,
      code: '000000',
      newPassword: 'sandi-baru-yang-kuat',
    });
    expect(tukar.statusCode).toBe(401);
    expect(tukar.json<{ error: { code: string } }>().error.code).toBe('invalid_code');
  }, 60_000);

  it('mengganti sandi, mencabut seluruh sesi, dan TIDAK menghasilkan sesi', async () => {
    const target = 'pulih@contoh.id';
    const sesiLama = await daftarDanVerifikasi(target);

    const minta = await post('/v1/auth/password/forgot', { email: target });
    const ticket = minta.json<{ data: { ticket: string } }>().data.ticket;
    const kode = h.lastCode();
    expect(kode?.purpose).toBe('reset');

    const reset = await post('/v1/auth/password/reset', {
      ticket,
      code: kode?.code,
      newPassword: 'sandi-pemulihan-baru',
    });

    expect(reset.statusCode).toBe(200);
    /* Bukan sesi — hanya objek kosong. §11 */
    expect(reset.json<{ data: Record<string, unknown> }>().data).toEqual({});

    /* Seluruh perangkat keluar: token lama tidak lagi bisa dirotasi. */
    const rotasi = await post('/v1/auth/refresh', {
      refreshToken: sesiLama.tokens.refreshToken,
      device: DEVICE,
    });
    expect(rotasi.statusCode).toBe(401);

    /* Sandi baru berlaku. */
    const masuk = await post('/v1/auth/sign-in', {
      email: target,
      password: 'sandi-pemulihan-baru',
      device: DEVICE,
    });
    expect(masuk.statusCode).toBe(200);
  }, 120_000);
});

describe('rotasi refresh', () => {
  it('merotasi token dan mencabut keluarga saat token lama dipakai ulang', async () => {
    const sesi = await daftarDanVerifikasi('rotasi@contoh.id');

    const pertama = await post('/v1/auth/refresh', {
      refreshToken: sesi.tokens.refreshToken,
      device: DEVICE,
    });
    expect(pertama.statusCode).toBe(200);
    const baru = pertama.json<{ data: { refreshToken: string } }>().data;
    expect(baru.refreshToken).not.toBe(sesi.tokens.refreshToken);

    /* Di dalam jendela grace, pengulangan mengembalikan respons yang sama —
       bukan menerbitkan generasi baru, dan bukan mencabut apa pun. */
    const ulang = await post('/v1/auth/refresh', {
      refreshToken: sesi.tokens.refreshToken,
      device: DEVICE,
    });
    expect(ulang.statusCode).toBe(200);
    expect(ulang.json<{ data: { refreshToken: string } }>().data.refreshToken).toBe(
      baru.refreshToken,
    );

    /* Setelah entri grace hilang, pengulangan yang sama menjadi pemakaian
       ulang dan mencabut SELURUH keluarga. §5.2 */
    h.redis.forget('grace:');

    const curian = await post('/v1/auth/refresh', {
      refreshToken: sesi.tokens.refreshToken,
      device: DEVICE,
    });
    expect(curian.statusCode).toBe(401);

    /* Korban ikut keluar — satu-satunya hasil aman ketika korban dan pencuri
       tidak bisa dibedakan. */
    const korban = await post('/v1/auth/refresh', {
      refreshToken: baru.refreshToken,
      device: DEVICE,
    });
    expect(korban.statusCode).toBe(401);
  }, 120_000);

  /* §5.3 — satu gangguan Redis tidak boleh mengeluarkan seluruh pengguna aktif.
     Ini temuan audit HIGH-7, dan satu-satunya cara membuktikannya adalah dengan
     benar-benar menjatuhkan cache-nya. */
  it('merotasi tanpa mencabut apa pun ketika cache grace sedang jatuh', async () => {
    const sesi = await daftarDanVerifikasi('degradasi@contoh.id');

    const pertama = await post('/v1/auth/refresh', {
      refreshToken: sesi.tokens.refreshToken,
      device: DEVICE,
    });
    expect(pertama.statusCode).toBe(200);
    const baru = pertama.json<{ data: { refreshToken: string } }>().data;

    h.redis.failing = true;
    let ulang: LightMyRequestResponse;
    try {
      ulang = await post('/v1/auth/refresh', {
        refreshToken: sesi.tokens.refreshToken,
        device: DEVICE,
      });
    } finally {
      h.redis.failing = false;
    }

    /* Bukan 401: pengulangan di dalam jendela grace yang tidak dapat
       diverifikasi diperlakukan sebagai rotasi, bukan sebagai pencurian. */
    expect(ulang.statusCode).toBe(200);
    expect(ulang.json<{ data: { refreshToken: string } }>().data.refreshToken).not.toBe(
      baru.refreshToken,
    );

    /* Keluarganya masih hidup — inilah yang gagal sebelum HIGH-7 ditutup. */
    const lanjut = await post('/v1/auth/refresh', {
      refreshToken: ulang.json<{ data: { refreshToken: string } }>().data.refreshToken,
      device: DEVICE,
    });
    expect(lanjut.statusCode).toBe(200);
  }, 120_000);

  it('mencabut keluarga saat token dipakai dari perangkat lain', async () => {
    const sesi = await daftarDanVerifikasi('perangkat@contoh.id');

    const res = await post('/v1/auth/refresh', {
      refreshToken: sesi.tokens.refreshToken,
      device: { deviceId: 'perangkat-yang-berbeda-9999', platform: 'android' },
    });
    expect(res.statusCode).toBe(401);
  }, 120_000);
});

describe('keluar', () => {
  it('memakai refresh token dan selalu menjawab 200', async () => {
    const sesi = await daftarDanVerifikasi('keluar@contoh.id');

    const keluar = await post('/v1/auth/sign-out', {
      refreshToken: sesi.tokens.refreshToken,
    });
    expect(keluar.statusCode).toBe(200);

    /* Token yang tidak dikenal pun tetap 200 — rute ini tidak boleh bisa
       dipakai menguji token mana yang berlaku. §6 */
    const asing = await post('/v1/auth/sign-out', {
      refreshToken: 'token-yang-sama-sekali-tidak-dikenal',
    });
    expect(asing.statusCode).toBe(200);

    const rotasi = await post('/v1/auth/refresh', {
      refreshToken: sesi.tokens.refreshToken,
      device: DEVICE,
    });
    expect(rotasi.statusCode).toBe(401);
  }, 120_000);
});

describe('identitas', () => {
  it('/me mengembalikan pengguna dengan access token yang sah', async () => {
    const sesi = await daftarDanVerifikasi('saya@contoh.id');

    const res = await get('/v1/auth/me', {
      authorization: `Bearer ${sesi.tokens.accessToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { email: string } }>().data.email).toBe('saya@contoh.id');
  }, 60_000);

  it('/me menolak tanpa header dan dengan token asing', async () => {
    const tanpa = await get('/v1/auth/me');
    expect(tanpa.statusCode).toBe(401);

    const asing = await get('/v1/auth/me', {
      authorization: 'Bearer bukan-token-sama-sekali',
    });
    expect(asing.statusCode).toBe(401);
  });

  it('JWKS menerbitkan kunci publik tanpa kunci privat', async () => {
    const res = await get('/.well-known/jwks.json');
    expect(res.statusCode).toBe(200);

    const body = res.json<{ keys: Record<string, unknown>[] }>();
    expect(body.keys.length).toBeGreaterThan(0);
    expect(body.keys[0]).not.toHaveProperty('d');
    expect(res.headers['cache-control']).toContain('max-age=600');
  });
});

describe('jejak audit', () => {
  it('rantai hash tetap utuh setelah seluruh alur di atas', async () => {
    const hasil = await verifyAuditChain(h.db);
    expect(hasil.intact).toBe(true);
    expect(hasil.checked).toBeGreaterThan(0);
    expect(hasil.brokenAtId).toBeNull();
  }, 60_000);
});
