import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';
import { looksLikeImage, MAX_IMAGE_BYTES } from '../reader.js';

/**
 * Uji rute Snap-Struk. ROADMAP M6.
 *
 * Yang diuji di sini adalah PENJAGANYA, bukan kualitas OCR-nya. OCR menuntut
 * gambar sungguhan dan model bahasa berukuran belasan megabita; kualitasnya
 * bergantung pada kamera dan pencahayaan, dan menegaskannya di suite otomatis
 * menghasilkan uji yang berkedip. Yang harus benar tanpa kecuali adalah bahwa
 * rute ini menolak apa yang harus ditolak — dan itulah yang diuji.
 *
 * Penguraiannya sendiri diuji lengkap di `parser.test.ts`, terhadap teks struk
 * Indonesia sungguhan dan tanpa satu pun gambar.
 */

let h: Harness;
let token = '';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(async () => {
  h = await createHarness();

  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      fullName: 'Struk Uji',
      email: 'struk@contoh.id',
      password: 'kantongz-sandi-kuat',
      device: DEVICE,
    },
  });

  const verify = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: {
      ticket: reg.json<{ data: { ticket: string } }>().data.ticket,
      code: h.lastCode()?.code,
      device: DEVICE,
    },
  });

  token = verify.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken;
}, 90_000);

afterAll(async () => {
  await h.close();
});

function scan(body: Buffer, bearer = token) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/receipts/scan',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'image/png' },
    payload: body,
  });
}

describe('pengenalan berkas', () => {
  /* Diperiksa dari ISI, bukan dari nama maupun `content-type` — keduanya
     dikendalikan pengunggah. */
  it('mengenali tanda tangan gambar yang sah', () => {
    expect(looksLikeImage(PNG_HEADER)).toBe(true);
    expect(looksLikeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(looksLikeImage(Buffer.from('RIFF....WEBP'))).toBe(true);
  });

  it('menolak isi yang bukan gambar meski content-type mengaku gambar', () => {
    expect(looksLikeImage(Buffer.from('#!/bin/sh\nrm -rf /'))).toBe(false);
    expect(looksLikeImage(Buffer.from('%PDF-1.7'))).toBe(false);
    expect(looksLikeImage(Buffer.alloc(0))).toBe(false);
  });
});

describe('penjaga rute', () => {
  it('menolak tanpa token', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/receipts/scan',
      headers: { 'content-type': 'image/png' },
      payload: PNG_HEADER,
    });

    expect(res.statusCode).toBe(401);
  });

  it('menolak token asing', async () => {
    expect((await scan(PNG_HEADER, 'bukan-token')).statusCode).toBe(401);
  });

  /*
   * Berkas sembarang yang menyamar sebagai gambar. Tanpa penjaga ini, isinya
   * diserahkan ke mesin WASM yang mencoba mengurainya — kegagalan yang lambat
   * alih-alih penolakan yang cepat, dan permukaan yang tidak perlu ada.
   */
  it('menolak berkas yang bukan gambar', async () => {
    const res = await scan(Buffer.from('#!/bin/sh\necho bukan gambar'));

    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_input');
  }, 30_000);

  it('menolak badan kosong', async () => {
    const res = await scan(Buffer.alloc(0));
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  }, 30_000);

  /* Batas badan rute ini dinyatakan SENDIRI dan tetap ada — bukan dihapus
     supaya gambar muat. Batas global 16 KB (§2) tidak dilonggarkan. */
  it('menolak gambar di atas batas ukuran', async () => {
    const besar = Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_IMAGE_BYTES + 1024)]);
    const res = await scan(besar);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  }, 60_000);

  it('rute lain tetap tunduk pada batas badan global', async () => {
    /* Pendaftaran dengan nama sepanjang 32 KB harus ditolak — pelonggaran batas
       untuk gambar tidak boleh bocor ke rute JSON. */
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        fullName: 'x'.repeat(32 * 1024),
        email: 'besar@contoh.id',
        password: 'kantongz-sandi-kuat',
        device: DEVICE,
      },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  }, 30_000);
});
