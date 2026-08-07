import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '../openapi.js';
import { createHarness, type Harness } from '../../modules/auth/__tests__/harness.js';

/**
 * Uji yang menjaga dokumen OpenAPI tidak membusuk.
 *
 * Dokumentasi yang tidak ditegakkan uji akan menyimpang dalam hitungan minggu:
 * rute ditambahkan tanpa dokumennya, rute dihapus tanpa dokumennya ikut hilang,
 * dan yang tersisa adalah berkas yang terlihat resmi tetapi berbohong.
 *
 * Yang dibandingkan adalah tabel rute Fastify yang SUNGGUHAN — bukan daftar
 * kedua yang harus dijaga sinkron secara manual.
 */

let h: Harness;

const BASE = 'https://api.kantongz.id';

/** Rute internal yang memang tidak didokumentasikan ke klien. */
const TIDAK_DIDOKUMENTASIKAN = new Set(['/*']);

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

/** Jalur Fastify (`/v1/goals/:id`) menjadi jalur OpenAPI (`/v1/goals/{id}`). */
function toOpenApiPath(route: string): string {
  return route.replace(/:([^/]+)/g, '{$1}');
}

/**
 * Rute yang benar-benar terdaftar, dari inventaris `onRoute`.
 *
 * Bukan diurai dari `printRoutes`: keluaran itu adalah pohon untuk manusia,
 * bentuknya berubah antar versi, dan penjaga yang bergantung padanya akan
 * berbunyi karena alasan yang salah.
 */
function registeredRoutes(): { method: string; url: string }[] {
  return h.app.routeInventory
    .filter((r) => !TIDAK_DIDOKUMENTASIKAN.has(r.url))
    /* HEAD dan OPTIONS dibuat Fastify dan @fastify/cors sendiri; keduanya
       mengikuti GET dan preflight, bukan permukaan yang dirancang. */
    .filter((r) => !['head', 'options'].includes(r.method));
}

describe('dokumen', () => {
  it('berbentuk OpenAPI 3.1 dengan info dan server', () => {
    const doc = buildOpenApiDocument(BASE);

    expect(doc.openapi).toBe('3.1.0');
    expect((doc.info as { title: string }).title).toBe('KANTONGZ API');
    expect((doc.servers as { url: string }[])[0]?.url).toBe(BASE);
  });

  it('disajikan di /openapi.json dengan cache-control', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age');
    expect(res.json<{ openapi: string }>().openapi).toBe('3.1.0');
  });

  it('tidak memuat satu pun $ref yang menggantung', () => {
    const doc = buildOpenApiDocument(BASE);
    const schemas = new Set(
      Object.keys((doc.components as { schemas: Record<string, unknown> }).schemas),
    );

    const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map(
      (m) => m[1],
    );

    expect(refs.length).toBeGreaterThan(0);
    for (const name of refs) {
      expect(schemas, name).toContain(name);
    }
  });
});

describe('kesetaraan dengan rute sungguhan', () => {
  it('setiap rute terdaftar ada di dokumen', () => {
    const doc = buildOpenApiDocument(BASE);
    const paths = doc.paths as Record<string, Record<string, unknown>>;

    const hilang = registeredRoutes()
      .filter((r) => {
        const entry = paths[toOpenApiPath(r.url)];
        return !entry || !(r.method in entry);
      })
      .map((r) => `${r.method.toUpperCase()} ${r.url}`);

    expect(hilang).toEqual([]);
  });

  it('setiap jalur di dokumen benar-benar terdaftar', () => {
    const doc = buildOpenApiDocument(BASE);
    const paths = doc.paths as Record<string, Record<string, unknown>>;

    const nyata = new Set(
      registeredRoutes().map((r) => `${r.method} ${toOpenApiPath(r.url)}`),
    );

    const hantu: string[] = [];
    for (const [path, operations] of Object.entries(paths)) {
      for (const method of Object.keys(operations)) {
        if (!nyata.has(`${method} ${path}`)) hantu.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(hantu).toEqual([]);
  });
});

describe('keamanan', () => {
  /* Setiap rute buku besar menuntut Bearer. Satu yang lupa menyatakannya di
     dokumen adalah satu yang pembacanya kira publik. */
  it('setiap rute /v1 selain autentikasi menyatakan bearerAuth', () => {
    const doc = buildOpenApiDocument(BASE);
    const paths = doc.paths as Record<string, Record<string, { security?: unknown[] }>>;

    const tanpaSecurity: string[] = [];

    for (const [path, operations] of Object.entries(paths)) {
      if (!path.startsWith('/v1/') || path.startsWith('/v1/auth/')) continue;
      for (const [method, operation] of Object.entries(operations)) {
        if (!operation.security) tanpaSecurity.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(tanpaSecurity).toEqual([]);
  });

  it('rute autentikasi publik TIDAK menuntut bearer', () => {
    const doc = buildOpenApiDocument(BASE);
    const paths = doc.paths as Record<string, Record<string, { security?: unknown[] }>>;

    for (const path of [
      '/v1/auth/register',
      '/v1/auth/sign-in',
      '/v1/auth/verify',
      '/v1/auth/refresh',
      '/v1/auth/password/forgot',
      '/v1/auth/password/reset',
      '/v1/auth/sign-out',
    ]) {
      expect(paths[path]?.post?.security, path).toBeUndefined();
    }
  });

  it('/v1/auth/me menuntut bearer', () => {
    const doc = buildOpenApiDocument(BASE);
    const paths = doc.paths as Record<string, Record<string, { security?: unknown[] }>>;

    expect(paths['/v1/auth/me']?.get?.security).toBeDefined();
  });
});

describe('bentuk yang didokumentasikan cocok dengan yang dikirim', () => {
  /*
   * Uji kontrak sudah menegakkan bentuk respons yang sungguhnya. Yang ditegakkan
   * di SINI adalah bahwa dokumennya menyatakan bentuk yang sama — dua sumber
   * kebenaran yang tidak pernah diadu akan menyimpang.
   */
  it('User di dokumen memuat kunci yang sama dengan User yang dikirim', async () => {
    const reg = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        fullName: 'Dokumen Uji',
        email: 'openapi-user@contoh.id',
        password: 'kantongz-sandi-kuat',
        device: { deviceId: 'openapi-device-01', platform: 'web' },
      },
    });

    const verify = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: {
        ticket: reg.json<{ data: { ticket: string } }>().data.ticket,
        code: h.lastCode()?.code,
        device: { deviceId: 'openapi-device-01', platform: 'web' },
      },
    });

    const dikirim = Object.keys(
      verify.json<{ data: { user: Record<string, unknown> } }>().data.user,
    ).sort();

    const doc = buildOpenApiDocument(BASE);
    const schema = (doc.components as { schemas: Record<string, { required: string[] }> }).schemas
      .User as { required: string[] } | undefined;

    expect([...(schema?.required ?? [])].sort()).toEqual(dikirim);
  }, 60_000);
});
