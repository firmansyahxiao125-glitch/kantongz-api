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
  /** Penghapusan permanen. Mati secara bawaan — lihat `config`. F4. */
  pembersihan: { aktif: boolean; tungguHari: number };
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
   * Memulihkan pembukuan dari berkas ekspor.
   *
   * Bawaannya PRATINJAU, sama seperti impor CSV, dan atas alasan yang lebih
   * kuat: yang diserahkan di sini seluruh pembukuan seseorang. Kelalaian
   * menyertakan satu bendera tidak boleh berakhir dengan ribuan baris yang
   * tertulis tanpa diminta.
   */
  app.post('/v1/account/restore', async (request, reply) => {
    const userId = await caller(request);
    const body = request.body as { dryRun?: unknown; data?: unknown } | undefined;
    const dryRun = body?.dryRun !== false;

    void reply.send(
      success(
        await service.restoreAccount(deps, userId, body?.data, { dryRun }, request.requestId),
        request.requestId,
      ),
    );
  });

  /**
   * Menghapus PERMANEN yang sudah dihapus-lunak dan sudah matang. F4.
   *
   * Bawaannya PRATINJAU, sama seperti pemulihan dan impor — dan di sini
   * taruhannya paling tinggi, karena ini satu-satunya tempat di seluruh
   * repositori yang tidak punya tombol batal.
   *
   * `dryRun !== false` dan bukan `dryRun === true`: badan yang tidak
   * menyebutkan benderanya sama sekali, badan yang kosong, dan badan yang
   * salah bentuk seluruhnya jatuh ke pratinjau.
   */
  app.post('/v1/account/purge', async (request, reply) => {
    const userId = await caller(request);
    const body = request.body as { dryRun?: unknown } | undefined;
    const dryRun = body?.dryRun !== false;

    void reply.send(
      success(
        await service.purgeDeleted(deps, userId, deps.pembersihan, { dryRun }, request.requestId),
        request.requestId,
      ),
    );
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
