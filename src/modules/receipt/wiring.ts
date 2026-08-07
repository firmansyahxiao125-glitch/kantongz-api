import type { Config } from '../../config/index.js';
import type { App } from '../../http/types.js';
import type { Logger } from '../../platform/observability/logger.js';
import { keyRingFromPem, type PemKeyPair } from '../tokens/keys.js';
import { createTesseractReader, type ReceiptReader } from './reader.js';
import { registerReceiptRoutes } from './routes.js';

/**
 * Perakitan modul struk.
 *
 * OCR lokal adalah satu-satunya implementasi hari ini, dan itu keputusan: foto
 * struk memuat nama, alamat, dan pola belanja seseorang, dan mengirimkannya ke
 * layanan penglihatan pihak ketiga harus menjadi keputusan sadar — bukan
 * bawaan yang tidak pernah ditanyakan.
 */
export async function registerReceipt(
  app: App,
  deps: { config: Config; logger: Logger },
): Promise<ReceiptReader> {
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

  const reader = createTesseractReader({
    languages: config.OCR_LANGUAGES,
    logger: deps.logger,
  });

  registerReceiptRoutes(app, {
    reader,
    ring: await keyRingFromPem(pairs),
    issuer: { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE },
  });

  return reader;
}
