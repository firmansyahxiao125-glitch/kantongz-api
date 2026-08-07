import { z } from 'zod';

import { AppError } from '../../contracts/errors.js';
import { DomainError } from '../../contracts/domain.js';
import { success } from '../../http/envelope.js';
import type { App } from '../../http/types.js';
import { verifyAccessToken, type IssuerConfig } from '../tokens/jwt.js';
import type { KeyRing } from '../tokens/keys.js';
import * as service from './service.js';
import type { InsightDeps } from './service.js';

/**
 * Rute wawasan. ROADMAP M9–M12.
 *
 * Sama seperti rute buku besar: `userId` datang dari klaim token, TIDAK PERNAH
 * dari badan atau parameter. Wawasan dibangun dari seluruh riwayat pengguna,
 * jadi satu id yang datang dari klien berarti seluruh pembukuan orang lain
 * dapat dianalisis oleh siapa pun.
 */

export interface InsightRouteDeps extends InsightDeps {
  ring: KeyRing;
  issuer: IssuerConfig;
}

const applySchema = z.object({
  transactionId: z.string().min(1).max(64),
  categoryId: z.string().min(1).max(64),
});

export function registerInsightRoutes(app: App, deps: InsightRouteDeps): void {
  async function callerId(request: { headers: Record<string, unknown> }): Promise<string> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AppError('session_expired');
    }
    const claims = await verifyAccessToken(deps.ring, deps.issuer, header.slice(7));
    return claims.sub;
  }

  app.get('/v1/insights', async (request, reply) => {
    const userId = await callerId(request);
    void reply.send(success(await service.digest(deps, userId), request.requestId));
  });

  app.get('/v1/insights/suggestions', async (request, reply) => {
    const userId = await callerId(request);
    void reply.send(success(await service.suggestCategories(deps, userId), request.requestId));
  });

  app.post('/v1/insights/suggestions/apply', async (request, reply) => {
    const userId = await callerId(request);

    const parsed = applySchema.safeParse(request.body);
    if (!parsed.success) throw new DomainError('invalid_input', 'permintaan tidak valid');

    await service.applySuggestion(
      deps,
      userId,
      parsed.data.transactionId,
      parsed.data.categoryId,
    );

    void reply.send(success({}, request.requestId));
  });
}
