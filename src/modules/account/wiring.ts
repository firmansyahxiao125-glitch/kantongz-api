import type { Config } from '../../config/index.js';
import type { Database } from '../../platform/db/client.js';
import type { App } from '../../http/types.js';
import { createKeyProvider } from '../../platform/crypto/keys.js';
import { keyRingFromPem, type PemKeyPair } from '../tokens/keys.js';
import { registerAccountRoutes } from './routes.js';

/**
 * Perakitan modul akun.
 *
 * Cincin kunci dibangun dari konfigurasi yang sama dengan modul lain — dua
 * sumber kunci yang berbeda adalah cara paling halus untuk membuat token yang
 * baru diterbitkan ditolak oleh rute di sebelahnya.
 */
export async function registerAccount(
  app: App,
  deps: { config: Config; db: Database },
): Promise<void> {
  const { config } = deps;

  const pairs: PemKeyPair[] = [
    { privatePkcs8: config.JWT_PRIVATE_KEY, publicSpki: config.JWT_PUBLIC_KEY },
  ];

  if (config.JWT_PREVIOUS_PRIVATE_KEY && config.JWT_PREVIOUS_PUBLIC_KEY) {
    pairs.push({
      privatePkcs8: config.JWT_PREVIOUS_PRIVATE_KEY,
      publicSpki: config.JWT_PREVIOUS_PUBLIC_KEY,
    });
  }

  registerAccountRoutes(app, {
    db: deps.db,
    keys: createKeyProvider({
      master: config.MASTER_KEY,
      activeHmacVersion: config.HMAC_KEY_VERSION,
    }),
    ring: await keyRingFromPem(pairs),
    issuer: { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE },
  });
}
