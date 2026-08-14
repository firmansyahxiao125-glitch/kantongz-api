import { z } from 'zod';

import { AppError } from '../../contracts/errors.js';
import { success } from '../../http/envelope.js';
import type { App } from '../../http/types.js';
import { verifyAccessToken, type IssuerConfig } from '../tokens/jwt.js';
import type { KeyRing } from '../tokens/keys.js';
import * as service from './service.js';
import type { AccountDeps } from './service.js';

export interface AccountRouteDeps extends AccountDeps {
  ring: KeyRing;
  issuer: IssuerConfig;
}

const schemas = {
  close: z.object({ password: z.string().min(1).max(512) }),
};

export function registerAccountRoutes(app: App, deps: AccountRouteDeps): void {
  async function caller(request: { headers: Record<string, unknown> }): Promise<string> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AppError('session_expired');
    }
    const claims = await verifyAccessToken(deps.ring, deps.issuer, header.slice(7));
    return claims.sub;
  }

  /*
   * Unduh seluruh data.
   *
   * `Content-Disposition: attachment` disetel di sini, bukan di klien: berkas
   * ekspor yang terbuka sebagai halaman JSON di tab peramban adalah berkas yang
   * tidak pernah tersimpan, dan pengguna yang mengiranya sudah tersimpan
   * kehilangan datanya justru saat ia menutup akunnya.
   */
  app.get('/v1/account/export', async (request, reply) => {
    const userId = await caller(request);
    const data = await service.exportAccount(deps, userId);
    const nama = `kantongz-${new Date().toISOString().slice(0, 10)}.json`;

    void reply
      .header('content-disposition', `attachment; filename="${nama}"`)
      .send(success(data, request.requestId));
  });

  /*
   * Menutup akun. Kata sandi diminta lagi — tindakan ini tidak dapat
   * dibatalkan sendiri oleh pengguna, dan perangkat yang tertinggal tidak
   * terkunci tidak boleh cukup untuk melakukannya.
   */
  app.post('/v1/account/close', async (request, reply) => {
    const userId = await caller(request);
    const parsed = schemas.close.safeParse(request.body);
    if (!parsed.success) throw new AppError('invalid_credentials');

    await service.closeAccount(deps, userId, parsed.data.password, request.requestId);
    void reply.send(success({}, request.requestId));
  });
}
