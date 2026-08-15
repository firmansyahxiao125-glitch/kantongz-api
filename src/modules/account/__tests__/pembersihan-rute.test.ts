import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../../../contracts/auth.js';
import type { Transaction, WalletAccount } from '../../../contracts/ledger.js';
import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';
import { createKeyProvider } from '../../../platform/crypto/keys.js';
import * as service from '../service.js';

/**
 * F4 — penghapusan permanen lewat jalur sungguhan.
 *
 * ── MENGAPA SEBAGIAN UJI MEMANGGIL LAYANAN, BUKAN RUTENYA ──────────────
 *
 * Harness merakit aplikasi dengan konfigurasi bawaan, dan bawaan F4 adalah
 * MATI. Itu justru yang paling penting diuji lewat rutenya — dan ia diuji di
 * bawah.
 *
 * Tetapi menguji apa yang terjadi ketika ia HIDUP menuntut aplikasi kedua
 * dengan konfigurasi berbeda. Memanggil `purgeDeleted` langsung dengan
 * pengaturan yang dinyalakan menguji hal yang sama tanpa merakit ulang
 * seluruh server — dan tanpa membuka satu pun jalur HTTP yang menghapus data
 * secara permanen di dalam rangkaian uji.
 */

let h: Harness;
let token = '';
let dompet = '';
let userId = '';

const PASSWORD = 'kantongz-sandi-kuat';

/* Kunci uji HARUS sama persis dengan yang dipakai harness. */
const KEYS = createKeyProvider({
  master: 'rahasia-induk-uji-yang-cukup-panjang',
  activeHmacVersion: 1,
});

const MATI = { aktif: false, tungguHari: 30 };
const HIDUP = { aktif: true, tungguHari: 30 };

beforeAll(async () => {
  h = await createHarness();

  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      fullName: 'Penguji Hapus',
      email: 'hapus@contoh.id',
      password: PASSWORD,
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
  const sesi = verify.json<{ data: Session }>().data;
  token = sesi.tokens.accessToken;
  userId = sesi.user.id;

  dompet = (await d<WalletAccount>(api('POST', '/v1/accounts', { name: 'Kas', kind: 'cash' }))).id;
}, 150_000);

afterAll(async () => {
  await h.close();
});

function api(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function d<T>(res: Promise<LightMyRequestResponse>): Promise<T> {
  const r = await res;
  if (r.statusCode >= 400) throw new Error(`${String(r.statusCode)} ${r.body}`);
  return r.json<{ data: T }>().data;
}

/** Satu transaksi yang dihapus-lunak, lalu dituakan sekian hari. */
async function hapusLunakLalu(hariLalu: number): Promise<string> {
  const t = await d<Transaction>(
    api('POST', '/v1/transactions', {
      accountId: dompet,
      kind: 'expense',
      amount: 12_000,
      occurredAt: Date.UTC(2026, 6, 1),
      merchant: 'UJI HAPUS',
    }),
  );

  const hapus = await api('DELETE', `/v1/transactions/${t.id}`);
  expect(hapus.statusCode).toBeLessThan(400);

  /* Ditinggalkan mundur lewat basis data: menunggu tiga puluh hari sungguhan
     bukan pilihan, dan memalsukan jam seluruh proses akan menggeser setiap
     uji lain di berkas ini. */
  await h.db.execute(
    `UPDATE transactions SET deleted_at = NOW() - INTERVAL '${String(hariLalu)} days' WHERE id = '${t.id}'`,
  );

  return t.id;
}

async function masihAda(id: string): Promise<boolean> {
  const rows = await h.db.execute(`SELECT id FROM transactions WHERE id = '${id}'`);
  return (rows as unknown as { rows: unknown[] }).rows.length > 0;
}

describe('F4 · MATI secara bawaan', () => {
  it('rutenya menolak selama server belum menyalakannya', async () => {
    /*
       Inti F4, dan diuji lewat aplikasi yang dirakit dengan konfigurasi
       BAWAAN — bukan dengan pengaturan yang dibuat-buat di dalam uji. Kalau
       bawaannya suatu hari berubah menjadi hidup, baris ini yang merah.
    */
    const res = await api('POST', '/v1/account/purge');

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('tidak diaktifkan');
  }, 60_000);

  it('menolak meski dryRun: false disertakan', async () => {
    /* Penghalang pertama diperiksa SEBELUM yang kedua. Permintaan yang paling
       bersungguh-sungguh pun tidak boleh menembus server yang mematikannya. */
    const id = await hapusLunakLalu(90);
    const res = await api('POST', '/v1/account/purge', { dryRun: false });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await masihAda(id)).toBe(true);
  }, 60_000);

  it('menolak tanpa token', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/v1/account/purge' });
    expect(res.statusCode).toBe(401);
  });

  it('layanan menolak ketika pengaturannya mati', async () => {
    await expect(
      service.purgeDeleted({ db: h.db, keys: KEYS }, userId, MATI, { dryRun: false }, 'req-uji'),
    ).rejects.toThrow(/tidak diaktifkan/);
  }, 60_000);
});

describe('F4 · pratinjau adalah bawaannya', () => {
  it('menghitung tanpa menghapus satu baris pun', async () => {
    const id = await hapusLunakLalu(90);

    const hasil = await service.purgeDeleted(
      { db: h.db, keys: KEYS },
      userId,
      HIDUP,
      { dryRun: true },
      'req-uji',
    );

    expect(hasil.pratinjau).toBe(true);
    expect(hasil.jumlah.transactions).toBeGreaterThanOrEqual(1);

    /* Yang menentukan bukan benderanya melainkan akibatnya. */
    expect(await masihAda(id)).toBe(true);
  }, 60_000);
});

describe('F4 · masa tunggu ditegakkan di jalur sungguhan', () => {
  it('yang BARU dihapus-lunak selamat', async () => {
    const baru = await hapusLunakLalu(1);

    await service.purgeDeleted(
      { db: h.db, keys: KEYS },
      userId,
      HIDUP,
      { dryRun: false },
      'req-uji',
    );

    expect(await masihAda(baru)).toBe(true);
  }, 60_000);

  it('yang sudah matang benar-benar HILANG', async () => {
    const lama = await hapusLunakLalu(90);
    const baru = await hapusLunakLalu(2);

    const hasil = await service.purgeDeleted(
      { db: h.db, keys: KEYS },
      userId,
      HIDUP,
      { dryRun: false },
      'req-uji',
    );

    expect(hasil.pratinjau).toBe(false);
    expect(await masihAda(lama)).toBe(false);
    expect(await masihAda(baru)).toBe(true);
    expect(hasil.belumMatang).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('transaksi yang MASIH HIDUP tidak pernah tersentuh', async () => {
    /* Penghalang yang paling menakutkan kalau gagal: pembersihan yang salah
       menyaring akan menghapus pembukuan yang sedang dipakai. */
    const hidup = await d<Transaction>(
      api('POST', '/v1/transactions', {
        accountId: dompet,
        kind: 'expense',
        amount: 77_000,
        occurredAt: Date.UTC(2026, 6, 2),
        merchant: 'MASIH HIDUP',
      }),
    );

    await service.purgeDeleted(
      { db: h.db, keys: KEYS },
      userId,
      HIDUP,
      { dryRun: false },
      'req-uji',
    );

    expect(await masihAda(hidup.id)).toBe(true);

    /* Dan ia masih terlihat lewat API, bukan sekadar masih ada di tabel. */
    const halaman = await d<{ items: Transaction[] }>(api('GET', '/v1/transactions?limit=100'));
    expect(halaman.items.some((t) => t.id === hidup.id)).toBe(true);
  }, 90_000);
});
