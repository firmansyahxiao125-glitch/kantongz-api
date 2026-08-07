import { z } from 'zod';

import { AppError } from '../../contracts/errors.js';
import { DomainError } from '../../contracts/domain.js';
import { success } from '../../http/envelope.js';
import type { App } from '../../http/types.js';
import { verifyAccessToken, type IssuerConfig } from '../tokens/jwt.js';
import type { KeyRing } from '../tokens/keys.js';
import { ask } from './ask.js';
import * as service from './service.js';
import type { AssistantDeps } from './service.js';

/**
 * Rute asisten. ROADMAP M11 dan M13.
 *
 * Keduanya menuntut Bearer dan mengambil `userId` dari klaim. Ringkasan dan
 * simulasi keduanya dibangun dari seluruh riwayat pengguna — satu id yang datang
 * dari klien berarti keuangan siapa pun dapat diringkas oleh siapa pun.
 */

export interface AssistantRouteDeps extends AssistantDeps {
  ring: KeyRing;
  issuer: IssuerConfig;
}

const askSchema = z.object({
  /* Batas panjang: pertanyaan lima ribu karakter bukan pertanyaan, dan
     pengenal maksud memindai seluruh teksnya. */
  question: z.string().trim().min(3).max(300),
});

const simulateSchema = z.object({
  monthlyCommitment: z.number().int().positive(),
  months: z.number().int().min(1).max(360),
});

export function registerAssistantRoutes(app: App, deps: AssistantRouteDeps): void {
  async function callerId(request: { headers: Record<string, unknown> }): Promise<string> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AppError('session_expired');
    }
    const claims = await verifyAccessToken(deps.ring, deps.issuer, header.slice(7));
    return claims.sub;
  }

  app.get('/v1/assistant/summary', async (request, reply) => {
    const userId = await callerId(request);
    void reply.send(success(await service.summarise(deps, userId), request.requestId));
  });

  app.post('/v1/assistant/ask', async (request, reply) => {
    const userId = await callerId(request);

    const parsed = askSchema.safeParse(request.body);
    if (!parsed.success) throw new DomainError('invalid_input', 'permintaan tidak valid');

    void reply.send(success(await ask(deps, userId, parsed.data.question), request.requestId));
  });

  app.post('/v1/assistant/simulate', async (request, reply) => {
    const userId = await callerId(request);

    const parsed = simulateSchema.safeParse(request.body);
    if (!parsed.success) throw new DomainError('invalid_input', 'permintaan tidak valid');

    void reply.send(success(await service.simulate(deps, userId, parsed.data), request.requestId));
  });
}
