import { SignJWT, jwtVerify } from 'jose';

import { AppError } from '../../contracts/errors.js';
import { SIGNING_ALG, type KeyRing } from './keys.js';

/**
 * Access token. M3_SPEC §4.
 *
 * Umur 10 menit untuk `member`, 2 menit untuk staf. Peran staf lebih pendek
 * karena pencabutan peran hanya berlaku setelah token kedaluwarsa (§10), dan
 * sebelas menit terlalu lama untuk akses yang dicabut karena insiden.
 */

export const ACCESS_TTL_SECONDS = {
  member: 10 * 60,
  staff: 2 * 60,
} as const;

const STAFF_ROLES = new Set(['support', 'admin']);

export interface AccessClaims {
  /** `users.id` */
  sub: string;
  /** `sessions.id` — juga identitas keluarga token. */
  sid: string;
  /** `devices.id` — ULID INTERNAL, bukan `device_id` mentah dari klien.
   *  JWT terbaca siapa pun yang memegangnya; menaruh pengenal klien di sana
   *  membatalkan seluruh alasan menyimpannya sebagai HMAC. §4.2 */
  did: string;
  rol: string[];
}

export interface IssuerConfig {
  issuer: string;
  audience: string;
}

export function accessTtlSeconds(roles: string[]): number {
  return roles.some((r) => STAFF_ROLES.has(r))
    ? ACCESS_TTL_SECONDS.staff
    : ACCESS_TTL_SECONDS.member;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: number;
}

/**
 * Tidak ada email, nama, atau saldo di dalam klaim. JWT bisa dibaca siapa pun
 * yang memegangnya; ia pengenal, bukan tempat menyimpan data. §4.2
 */
export async function issueAccessToken(
  ring: KeyRing,
  cfg: IssuerConfig,
  claims: AccessClaims,
  now: number = Date.now(),
): Promise<IssuedAccessToken> {
  const ttl = accessTtlSeconds(claims.rol);
  const iat = Math.floor(now / 1000);
  const exp = iat + ttl;

  const token = await new SignJWT({ sid: claims.sid, did: claims.did, rol: claims.rol })
    .setProtectedHeader({ alg: SIGNING_ALG, kid: ring.active.kid, typ: 'JWT' })
    .setIssuer(cfg.issuer)
    .setAudience(cfg.audience)
    .setSubject(claims.sub)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(crypto.randomUUID())
    .sign(ring.active.privateKey);

  return { token, expiresAt: exp * 1000 };
}

/**
 * Verifikasi lengkap: tanda tangan, `exp`, `iss`, `aud`, dan `kid` yang dikenal.
 *
 * Melempar `session_expired` untuk SETIAP kegagalan. Membedakan "tanda tangan
 * salah" dari "kedaluwarsa" memberi penyerang informasi tentang token yang ia
 * pegang, dan tidak memberi pengguna sah apa pun yang berguna.
 */
export async function verifyAccessToken(
  ring: KeyRing,
  cfg: IssuerConfig,
  token: string,
): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(
      token,
      (header) => {
        const key = header.kid ? ring.find(header.kid) : undefined;
        if (!key) throw new AppError('session_expired', 'kid tidak dikenal');
        return Promise.resolve(key.publicKey);
      },
      { issuer: cfg.issuer, audience: cfg.audience, algorithms: [SIGNING_ALG] },
    );

    const sid = payload.sid;
    const did = payload.did;
    const rol = payload.rol;

    if (
      typeof payload.sub !== 'string' ||
      typeof sid !== 'string' ||
      typeof did !== 'string' ||
      !Array.isArray(rol)
    ) {
      throw new AppError('session_expired', 'klaim tidak lengkap');
    }

    return { sub: payload.sub, sid, did, rol: rol.map(String) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('session_expired', 'token tidak berlaku');
  }
}
