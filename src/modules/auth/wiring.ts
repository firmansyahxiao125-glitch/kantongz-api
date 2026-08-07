import type { Redis } from 'ioredis';

import type { Config } from '../../config/index.js';
import type { Database } from '../../platform/db/client.js';
import { createKeyProvider } from '../../platform/crypto/keys.js';
import type { Logger } from '../../platform/observability/logger.js';
import { keyRingFromPem, type PemKeyPair } from '../tokens/keys.js';
import { registerAuthRoutes } from './routes.js';
import type { AuthDeps } from './service.js';
import type { App } from '../../http/types.js';

/**
 * Perakitan modul autentikasi dari konfigurasi.
 *
 * Berkas ini sengaja terpisah dari `routes.ts`: rute menerima dependensi yang
 * sudah jadi sehingga dapat diuji tanpa variabel lingkungan, dan penerjemahan
 * dari konfigurasi menjadi dependensi hidup di satu tempat yang dapat dibaca
 * sekaligus.
 */

export interface AuthWiring {
  config: Config;
  db: Database;
  redis: Redis;
  logger: Logger;
}

/**
 * Penyaluran kode verifikasi.
 *
 * M3.7 menggantikan ini dengan outbox transaksional. Sampai saat itu kode
 * dicatat sebagai peristiwa terstruktur — dan `code` TIDAK ikut tercatat,
 * karena `redact` di logger sudah menyensornya dan mencetaknya lewat jalur lain
 * akan membatalkan seluruh gunanya.
 */
function logDelivery(logger: Logger) {
  return (to: string, purpose: 'verify' | 'reset'): Promise<void> => {
    logger.info({ purpose, recipient: to.slice(0, 1) }, 'kode verifikasi disalurkan');
    return Promise.resolve();
  };
}

/**
 * Menerjemahkan konfigurasi menjadi dependensi layanan.
 *
 * Terpisah dari `registerAuth` supaya pengujian dapat memakai jalur perakitan
 * yang sama persis dengan produksi sambil mengganti penyaluran kodenya. Perakit
 * uji yang membangun dependensinya sendiri akan berhenti menguji berkas ini.
 */
export async function buildAuthDeps(deps: AuthWiring): Promise<AuthDeps> {
  const { config } = deps;

  const pairs: PemKeyPair[] = [
    { privatePkcs8: config.JWT_PRIVATE_KEY, publicSpki: config.JWT_PUBLIC_KEY },
  ];

  /* Kunci lama diletakkan SESUDAH yang aktif: `buildRing` memilih elemen
     pertama sebagai penanda tangan, dan yang lain hanya memverifikasi. */
  if (config.JWT_PREVIOUS_PRIVATE_KEY && config.JWT_PREVIOUS_PUBLIC_KEY) {
    pairs.push({
      privatePkcs8: config.JWT_PREVIOUS_PRIVATE_KEY,
      publicSpki: config.JWT_PREVIOUS_PUBLIC_KEY,
    });
  }

  return {
    db: deps.db,
    redis: deps.redis,
    keys: createKeyProvider({
      master: config.MASTER_KEY,
      activeHmacVersion: config.HMAC_KEY_VERSION,
    }),
    ring: await keyRingFromPem(pairs),
    issuer: { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE },
  };
}

export async function registerAuth(app: App, deps: AuthWiring): Promise<void> {
  registerAuthRoutes(app, {
    ...(await buildAuthDeps(deps)),
    deliverCode: logDelivery(deps.logger),
  });
}
