import { exportJWK, generateKeyPair, importPKCS8, importSPKI, type JWK, type KeyObject } from 'jose';
import { createHash } from 'node:crypto';

/**
 * Bahan kunci penandatangan. M3_SPEC §4.3.
 *
 * Di produksi kunci privat berada di KMS dan tidak pernah meninggalkannya;
 * antarmuka ini yang menjadi tempat penyambungannya. Di pengembangan dan
 * pengujian, pasangan kunci dibangkitkan saat boot.
 *
 * DUA `kid` aktif bersamaan selama masa tumpang tindih rotasi — token yang
 * ditandatangani kunci lama harus tetap terverifikasi sampai kedaluwarsa, dan
 * umur access token sepuluh menit sengaja dipilih lebih pendek dari cache JWKS
 * supaya jendela itu selalu tertutup.
 */

export interface SigningKey {
  kid: string;
  privateKey: KeyObject | CryptoKey;
  publicKey: KeyObject | CryptoKey;
}

export interface KeyRing {
  /** Kunci yang menandatangani token baru. */
  active: SigningKey;
  /** Seluruh kunci yang masih boleh memverifikasi, termasuk yang aktif. */
  all: SigningKey[];
  jwks: () => Promise<{ keys: JWK[] }>;
  find: (kid: string) => SigningKey | undefined;
}

const ALG = 'RS256';

/** `kid` diturunkan dari kunci publiknya sendiri — deterministik, dan tidak
 *  perlu dicatat di tempat kedua yang bisa menyimpang. */
async function keyId(publicKey: KeyObject | CryptoKey): Promise<string> {
  const jwk = await exportJWK(publicKey);
  return createHash('sha256')
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest('base64url')
    .slice(0, 22);
}

async function toSigningKey(
  privateKey: KeyObject | CryptoKey,
  publicKey: KeyObject | CryptoKey,
): Promise<SigningKey> {
  return { kid: await keyId(publicKey), privateKey, publicKey };
}

export async function generateKeyRing(): Promise<KeyRing> {
  const pair = await generateKeyPair(ALG, { extractable: true });
  return buildRing([await toSigningKey(pair.privateKey, pair.publicKey)]);
}

export interface PemKeyPair {
  privatePkcs8: string;
  publicSpki: string;
}

export async function keyRingFromPem(pairs: PemKeyPair[]): Promise<KeyRing> {
  const keys = await Promise.all(
    pairs.map(async (p) =>
      toSigningKey(await importPKCS8(p.privatePkcs8, ALG), await importSPKI(p.publicSpki, ALG)),
    ),
  );
  return buildRing(keys);
}

function buildRing(keys: SigningKey[]): KeyRing {
  const active = keys[0];
  if (!active) throw new Error('KeyRing membutuhkan sekurang-kurangnya satu kunci');

  return {
    active,
    all: keys,
    find: (kid) => keys.find((k) => k.kid === kid),
    jwks: async () => ({
      keys: await Promise.all(
        keys.map(async (k) => ({
          ...(await exportJWK(k.publicKey)),
          kid: k.kid,
          alg: ALG,
          use: 'sig',
        })),
      ),
    }),
  };
}

export const SIGNING_ALG = ALG;
