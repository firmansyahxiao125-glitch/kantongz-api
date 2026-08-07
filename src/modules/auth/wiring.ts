import type { Redis } from 'ioredis';

import type { Config } from '../../config/index.js';
import type { Database } from '../../platform/db/client.js';
import { createKeyProvider } from '../../platform/crypto/keys.js';
import type { Logger } from '../../platform/observability/logger.js';
import { keyRingFromPem, type PemKeyPair } from '../tokens/keys.js';
import { enqueue } from '../outbox/index.js';
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
 * Penyaluran kode verifikasi lewat outbox. §7.
 *
 * Baris outbox, bukan panggilan langsung ke penyedia email. Panggilan langsung
 * yang gagal meninggalkan akun yang terbuat tanpa email verifikasi terkirim —
 * dan pengguna terjebak dengan akun yang tidak bisa diaktifkan dan tidak bisa
 * didaftar ulang.
 *
 * `idempotencyKey` diturunkan dari tiketnya: satu tiket berhak atas tepat satu
 * email, berapa kali pun jalur ini terpanggil ulang.
 */
function outboxDelivery(db: Database, logger: Logger): DeliverCode {
  return async (to, purpose, code, ticket) => {
    await enqueue(
      db,
      purpose === 'verify' ? 'email.verify' : 'email.reset',
      `${purpose}:${ticket}`,
      { to, code },
    );

    /* Yang dicatat hanya bahwa sesuatu diantrekan. Alamat dan kodenya tidak. */
    logger.info({ purpose }, 'kode diantrekan ke outbox');
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

export type DeliverCode = (
  to: string,
  purpose: 'verify' | 'reset',
  code: string,
  /** Tiket yang menerbitkan kode ini. Menjadi kunci idempotensi outbox: satu
   *  tiket berhak atas tepat satu email. */
  ticket: string,
) => Promise<void>;

export async function registerAuth(
  app: App,
  deps: AuthWiring,
  /* Hanya mode mandiri yang menggantinya, dan hanya untuk mencetak kodenya ke
     terminal. Di produksi tidak ada pemanggil yang meneruskan argumen ini. */
  deliverCode?: DeliverCode,
): Promise<void> {
  registerAuthRoutes(app, {
    ...(await buildAuthDeps(deps)),
    deliverCode: deliverCode ?? outboxDelivery(deps.db, deps.logger),
  });
}
