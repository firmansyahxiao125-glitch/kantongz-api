import type { Config } from '../../config/index.js';
import type { Database } from '../../platform/db/client.js';
import type { App } from '../../http/types.js';
import { keyRingFromPem, type PemKeyPair } from '../tokens/keys.js';
import { registerLedgerRoutes } from './routes.js';

/**
 * Perakitan modul buku besar.
 *
 * Cincin kunci dibangun dari konfigurasi yang sama dengan modul autentikasi —
 * keduanya harus memverifikasi token yang sama, dan dua sumber kunci yang
 * berbeda adalah cara paling halus untuk membuat token yang baru diterbitkan
 * ditolak oleh rute di sebelahnya.
 */
export async function registerLedger(
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

  registerLedgerRoutes(app, {
    db: deps.db,
    ring: await keyRingFromPem(pairs),
    issuer: { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE },
  });
}
