import { z } from 'zod';

import { DomainError } from '../../contracts/domain.js';
import { AppError } from '../../contracts/errors.js';
import { success } from '../../http/envelope.js';
import type { App } from '../../http/types.js';
import { verifyAccessToken } from '../tokens/jwt.js';
import * as service from './service.js';
import type { AuthDeps, RequestContext } from './service.js';

/**
 * Rute autentikasi. M3_SPEC §17.
 *
 * Lapisan ini hanya menerjemahkan HTTP menjadi pemanggilan layanan dan
 * kembali. Tidak ada satu pun aturan bisnis di sini — rute yang memutuskan
 * sesuatu adalah rute yang tidak bisa diuji tanpa server.
 */

const deviceSchema = z.object({
  deviceId: z.string().min(8).max(128),
  platform: z.enum(['ios', 'android', 'web']),
  model: z.string().max(120).optional(),
  appVersion: z.string().max(40).optional(),
});

const emailSchema = z.string().email().max(254);
const passwordSchema = z.string().min(1).max(512);

const schemas = {
  signIn: z.object({ email: emailSchema, password: passwordSchema, device: deviceSchema }),
  register: z.object({
    fullName: z.string().min(1).max(120),
    email: emailSchema,
    password: passwordSchema,
    device: deviceSchema,
  }),
  verify: z.object({
    ticket: z.string().min(1).max(256),
    code: z.string().min(4).max(12),
    device: deviceSchema,
  }),
  refresh: z.object({ refreshToken: z.string().min(16).max(256), device: deviceSchema }),
  forgot: z.object({ email: emailSchema }),
  reset: z.object({
    ticket: z.string().min(1).max(256),
    code: z.string().min(4).max(12),
    newPassword: passwordSchema,
  }),
  signOut: z.object({ refreshToken: z.string().min(16).max(256) }),
};

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  /*
   * Bentuk masukan yang salah tidak pernah menjelaskan dirinya ke klien —
   * pesan validasi membocorkan bentuk API kepada siapa pun yang menebak. Itu
   * tetap berlaku: kalimat di bawah SENGAJA tidak menyebut kolom mana pun.
   *
   * Yang diperbaiki adalah KODENYA. Sebelum ini `AppError('unknown')`, dan
   * `unknown` memetakan ke 500 — jadi setiap badan permintaan auth yang cacat
   * dijawab "kesalahan server". Terukur: `deviceId` 5 karakter (skemanya
   * menuntut 8) pada `POST /v1/auth/sign-in` mengembalikan 500, sementara
   * `openapi.json` menjanjikan 422 untuk rute yang sama.
   *
   * Akibatnya bukan cuma kosmetik. Klien tidak bisa membedakan "masukanmu
   * salah" dari "peladen kami rusak", jadi ia mengulang permintaan yang tidak
   * akan pernah berhasil; dan setiap klien ceroboh menaikkan angka 5xx yang
   * seharusnya membangunkan manusia hanya ketika kita yang salah.
   *
   * `invalid_input` (422) adalah kode yang SUDAH dipakai modul buku besar,
   * asisten, dan wawasan untuk hal yang sama persis. Auth satu-satunya yang
   * menyimpang.
   */
  if (!result.success) throw new DomainError('invalid_input', 'permintaan tidak valid');
  return result.data;
}

export interface RouteDeps extends AuthDeps {
  /** Menyalurkan kode verifikasi ke antrean email (outbox, §7). `ticket`
   *  menjadi kunci idempotensinya: satu tiket berhak atas tepat satu email. */
  deliverCode: (
    to: string,
    purpose: 'verify' | 'reset',
    code: string,
    ticket: string,
  ) => Promise<void>;
}

export function registerAuthRoutes(app: App, deps: RouteDeps): void {
  const ctxOf = (request: { requestId: string; ip: string; headers: Record<string, unknown> }): RequestContext => ({
    requestId: request.requestId,
    ip: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  app.post('/v1/auth/sign-in', async (request, reply) => {
    const body = parse(schemas.signIn, request.body);
    const session = await service.signIn(deps, body, ctxOf(request));
    void reply.send(success(session, request.requestId));
  });

  app.post('/v1/auth/register', async (request, reply) => {
    const body = parse(schemas.register, request.body);
    const { code, ...pending } = await service.register(deps, body, ctxOf(request));
    await deps.deliverCode(body.email, 'verify', code, pending.ticket);
    void reply.status(201).send(success(pending, request.requestId));
  });

  app.post('/v1/auth/verify', async (request, reply) => {
    const body = parse(schemas.verify, request.body);
    const session = await service.verifyRegistration(deps, body, ctxOf(request));
    void reply.send(success(session, request.requestId));
  });

  app.post('/v1/auth/refresh', async (request, reply) => {
    const body = parse(schemas.refresh, request.body);
    const tokens = await service.refresh(deps, body, ctxOf(request));
    void reply.send(success(tokens, request.requestId));
  });

  app.post('/v1/auth/password/forgot', async (request, reply) => {
    const body = parse(schemas.forgot, request.body);
    const { code, ...pending } = await service.requestPasswordReset(deps, body.email, ctxOf(request));
    /* Kode hanya dikirim bila akunnya nyata. Tiket hantu tidak punya kode, dan
       tidak ada email yang berangkat ke alamat yang tidak terdaftar. */
    if (code) await deps.deliverCode(body.email, 'reset', code, pending.ticket);
    void reply.send(success(pending, request.requestId));
  });

  app.post('/v1/auth/password/reset', async (request, reply) => {
    const body = parse(schemas.reset, request.body);
    await service.resetPassword(deps, body, ctxOf(request));
    /* TIDAK menghasilkan sesi. §11 */
    void reply.send(success({}, request.requestId));
  });

  /*
   * Memakai refresh token di badan, BUKAN access token di header. §6 —
   * batas diam 15 menit memanggil rute ini ketika access token berumur 10 menit
   * sudah mati lima menit sebelumnya. Rute yang menuntut Bearer akan menjawab
   * 401 tepat pada satu-satunya kesempatan ia paling dibutuhkan.
   */
  app.post('/v1/auth/sign-out', async (request, reply) => {
    const body = parse(schemas.signOut, request.body);
    await service.signOut(deps, body.refreshToken, ctxOf(request));
    void reply.send(success({}, request.requestId));
  });

  app.get('/v1/auth/me', async (request, reply) => {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AppError('session_expired');
    }

    const claims = await verifyAccessToken(deps.ring, deps.issuer, header.slice(7));
    const user = await service.currentUser(deps, claims.sub);
    void reply.send(success(user, request.requestId));
  });

  /** §4.3 — kunci publik, di-cache sepuluh menit oleh gateway. */
  app.get('/.well-known/jwks.json', async (_request, reply) => {
    void reply.header('cache-control', 'public, max-age=600').send(await deps.ring.jwks());
  });
}
