import { beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../../contracts/errors.js';
import { ACCESS_TTL_SECONDS, accessTtlSeconds, issueAccessToken, verifyAccessToken } from '../jwt.js';
import { generateKeyRing, type KeyRing } from '../keys.js';

const cfg = { issuer: 'https://api.kantongz.id', audience: 'kantongz-mobile' };
const claims = { sub: 'usr_1', sid: 'ses_1', did: 'dev_1', rol: ['member'] };

describe('access token', () => {
  let ring: KeyRing;
  let ringLain: KeyRing;

  beforeAll(async () => {
    ring = await generateKeyRing();
    ringLain = await generateKeyRing();
  });

  it('menerbitkan dan memverifikasi token', async () => {
    const { token } = await issueAccessToken(ring, cfg, claims);
    const hasil = await verifyAccessToken(ring, cfg, token);
    expect(hasil).toEqual(claims);
  });

  it('menyertakan kid di header', async () => {
    const { token } = await issueAccessToken(ring, cfg, claims);
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()) as {
      kid: string;
      alg: string;
    };
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe(ring.active.kid);
  });

  /* §4.2 — JWT terbaca siapa pun yang memegangnya. Ia pengenal, bukan tempat
     menyimpan data. */
  it('tidak memuat email, nama, atau apa pun selain pengenal', async () => {
    const { token } = await issueAccessToken(ring, cfg, claims);
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as
      Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(
      ['aud', 'did', 'exp', 'iat', 'iss', 'jti', 'rol', 'sid', 'sub'].sort(),
    );
    expect(JSON.stringify(payload)).not.toMatch(/@/);
  });

  it('menolak token dari kunci lain', async () => {
    const { token } = await issueAccessToken(ringLain, cfg, claims);
    await expect(verifyAccessToken(ring, cfg, token)).rejects.toBeInstanceOf(AppError);
  });

  it('menolak audience yang salah', async () => {
    const { token } = await issueAccessToken(ring, cfg, claims);
    await expect(
      verifyAccessToken(ring, { ...cfg, audience: 'lain' }, token),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('menolak issuer yang salah', async () => {
    const { token } = await issueAccessToken(ring, cfg, claims);
    await expect(
      verifyAccessToken(ring, { ...cfg, issuer: 'https://jahat.example' }, token),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('menolak token kedaluwarsa', async () => {
    const lampau = Date.now() - (ACCESS_TTL_SECONDS.member + 60) * 1000;
    const { token } = await issueAccessToken(ring, cfg, claims, lampau);
    await expect(verifyAccessToken(ring, cfg, token)).rejects.toBeInstanceOf(AppError);
  });

  it('menolak token yang dirusak', async () => {
    const { token } = await issueAccessToken(ring, cfg, claims);
    await expect(verifyAccessToken(ring, cfg, `${token}x`)).rejects.toBeInstanceOf(AppError);
  });

  /* Seluruh kegagalan memakai kode yang sama — membedakannya memberi penyerang
     informasi tentang token yang ia pegang. */
  it('memakai session_expired untuk setiap kegagalan', async () => {
    await expect(verifyAccessToken(ring, cfg, 'bukan.jwt.sama.sekali')).rejects.toMatchObject({
      code: 'session_expired',
    });
  });
});

describe('umur token menurut peran', () => {
  it('member 10 menit', () => {
    expect(accessTtlSeconds(['member'])).toBe(ACCESS_TTL_SECONDS.member);
  });

  /* §4.3 — pencabutan peran hanya berlaku setelah token kedaluwarsa, dan
     sebelas menit terlalu lama untuk akses staf yang dicabut karena insiden. */
  it('staf 2 menit', () => {
    expect(accessTtlSeconds(['support'])).toBe(ACCESS_TTL_SECONDS.staff);
    expect(accessTtlSeconds(['admin'])).toBe(ACCESS_TTL_SECONDS.staff);
    expect(accessTtlSeconds(['member', 'support'])).toBe(ACCESS_TTL_SECONDS.staff);
  });
});

describe('JWKS', () => {
  it('menerbitkan kunci publik dengan kid dan alg', async () => {
    const ring = await generateKeyRing();
    const jwks = await ring.jwks();

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kid: ring.active.kid, alg: 'RS256', use: 'sig' });
    /* Kunci PRIVAT tidak boleh pernah muncul di JWKS. */
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });
});
