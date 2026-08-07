import type { Config } from '../../config/index.js';
import type { Database } from '../../platform/db/client.js';
import type { App } from '../../http/types.js';
import type { Logger } from '../../platform/observability/logger.js';
import { keyRingFromPem, type PemKeyPair } from '../tokens/keys.js';
import { createOllamaModel, probeOllama } from './ollama.js';
import { createAnthropicModel, unavailableModel, type LanguageModel } from './provider.js';
import { registerAssistantRoutes } from './routes.js';

/**
 * Perakitan modul asisten.
 *
 * Satu-satunya tempat yang memutuskan penyedia mana yang dipakai. Sisa lapisan
 * asisten tidak pernah membaca konfigurasi, dan karena itu dapat diuji dengan
 * model palsu tanpa satu pun variabel lingkungan.
 *
 * URUTANNYA ADALAH KEBIJAKAN:
 *
 *   1. Ollama lokal — BAWAAN. Tanpa akun, tanpa biaya berulang, dan tanpa satu
 *      pun byte data keuangan meninggalkan mesin pengguna.
 *   2. Anthropic — adaptor OPSIONAL, hanya bila kuncinya sengaja dipasang.
 *   3. Templat — selalu ada, dan tetap berguna.
 *
 * Ketiganya menghasilkan angka yang SAMA. Yang berbeda hanya kalimatnya, sebab
 * seluruh perhitungan dilakukan server dan tidak pernah oleh model.
 */
export async function modelFor(config: Config, logger: Logger): Promise<LanguageModel> {
  const ollama = {
    baseUrl: config.OLLAMA_BASE_URL,
    model: config.OLLAMA_MODEL,
    timeoutMs: config.OLLAMA_TIMEOUT_MS,
  };

  if (await probeOllama(ollama)) {
    logger.info({ model: ollama.model }, 'asisten memakai model lokal');
    return createOllamaModel(ollama, true);
  }

  /* Anthropic hanya bila kuncinya SENGAJA dipasang. Ia tidak pernah menjadi
     bawaan, dan ketiadaannya bukan kegagalan. */
  if (config.ANTHROPIC_API_KEY) {
    logger.info({ model: config.ANTHROPIC_MODEL }, 'asisten memakai penyedia awan');
    return createAnthropicModel({
      apiKey: config.ANTHROPIC_API_KEY,
      model: config.ANTHROPIC_MODEL,
    });
  }

  logger.warn(
    { ollama: ollama.baseUrl, model: ollama.model },
    'tidak ada penyedia model — ringkasan disusun templat, dan aplikasi mengatakannya kepada pengguna',
  );

  return unavailableModel('Ollama tidak berjalan dan tidak ada penyedia awan yang dipasang');
}

export async function registerAssistant(
  app: App,
  deps: { config: Config; db: Database; logger: Logger },
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

  registerAssistantRoutes(app, {
    db: deps.db,
    model: await modelFor(config, deps.logger),
    ring: await keyRingFromPem(pairs),
    issuer: { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE },
  });
}
