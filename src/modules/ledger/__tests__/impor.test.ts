import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../../../contracts/auth.js';
import type {
  Category,
  ImportReport,
  TransactionPage,
  WalletAccount,
} from '../../../contracts/ledger.js';
import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';
import { MAX_ROWS } from '../impor.js';

/**
 * Impor transaksi terhadap PostgreSQL sungguhan.
 *
 * Yang diuji di sini bukan "apakah barisnya masuk" — itu bagian yang mudah.
 * Yang diuji adalah apa yang terjadi ketika berkas yang SAMA diunggah dua
 * kali, karena itulah yang benar-benar dilakukan orang: mengunduh mutasi
 * bulan ini, lalu bulan depan mengunduh mutasi dua bulan.
 */

let h: Harness;
let alice = '';
let bob = '';
let dompetAlice = '';
let kategoriAlice = '';
let kategoriPemasukan = '';

const PASSWORD = 'kantongz-sandi-kuat';
const HARI = 86_400_000;
/* Tengah hari, sama seperti yang ditulis antarmuka — jauh dari kedua tepi
   hari, jadi pengujiannya tidak bergantung pada zona mesin yang menjalankan. */
const SAAT = Date.UTC(2026, 4, 12, 5);

beforeAll(async () => {
  h = await createHarness();
  alice = await masuk('imp-alice@contoh.id');
  bob = await masuk('imp-bob@contoh.id');

  dompetAlice = (
    await data<WalletAccount>(
      api(alice, 'POST', '/v1/accounts', { name: 'Bank Impor', kind: 'bank' }),
    )
  ).id;
  const kategori = await data<Category[]>(api(alice, 'GET', '/v1/categories'));
  kategoriAlice = kategori.find((c) => c.kind === 'expense')?.id ?? '';
  kategoriPemasukan = kategori.find((c) => c.kind === 'income')?.id ?? '';
}, 120_000);

afterAll(async () => {
  await h.close();
});

async function masuk(email: string): Promise<string> {
  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { fullName: 'Penguji', email, password: PASSWORD, device: DEVICE },
  });
  const ticket = reg.json<{ data: { ticket: string } }>().data.ticket;

  const verify = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { ticket, code: h.lastCode()?.code, device: DEVICE },
  });

  return verify.json<{ data: Session }>().data.tokens.accessToken;
}

function api(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

async function data<T>(response: Promise<LightMyRequestResponse>): Promise<T> {
  const res = await response;
  if (res.statusCode >= 400) throw new Error(`${String(res.statusCode)} ${res.body}`);
  return res.json<{ data: T }>().data;
}

function baris(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: dompetAlice,
    categoryId: kategoriAlice,
    kind: 'expense',
    amount: 55_000,
    occurredAt: SAAT,
    merchant: 'Warung Impor',
    ...over,
  };
}

const impor = (token: string, rows: Record<string, unknown>[], dryRun = true): Promise<ImportReport> =>
  data<ImportReport>(api(token, 'POST', '/v1/transactions/import', { dryRun, rows }));

async function hitung(token: string, merchant: string): Promise<number> {
  const halaman = await data<TransactionPage>(api(token, 'GET', '/v1/transactions?limit=100'));
  return halaman.items.filter((t) => t.merchant === merchant).length;
}

/* ── pratinjau ───────────────────────────────────────────────────────── */

describe('pratinjau', () => {
  it('menolak tanpa token', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/transactions/import',
      payload: { dryRun: true, rows: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('TIDAK menulis apa pun', async () => {
    const merchant = `pratinjau-${String(Date.now())}`;
    const laporan = await impor(alice, [baris({ merchant })]);

    expect(laporan.dryRun).toBe(true);
    expect(laporan.imported).toBe(1);
    expect(await hitung(alice, merchant)).toBe(0);
  });

  it('bawaannya pratinjau ketika benderanya tidak disebut', async () => {
    /* Kelalaian menyertakan `dryRun` tidak boleh berakhir dengan lima ratus
       baris yang tertulis tanpa diminta. */
    const merchant = `bawaan-${String(Date.now())}`;
    const laporan = await data<ImportReport>(
      api(alice, 'POST', '/v1/transactions/import', { rows: [baris({ merchant })] }),
    );

    expect(laporan.dryRun).toBe(true);
    expect(await hitung(alice, merchant)).toBe(0);
  });

  it('berkas kosong bukan galat', async () => {
    const laporan = await impor(alice, []);
    expect(laporan).toMatchObject({ total: 0, imported: 0, duplicate: 0, failed: 0 });
  });
});

/* ── penulisan ───────────────────────────────────────────────────────── */

describe('penulisan', () => {
  it('menulis ketika diminta', async () => {
    const merchant = `tulis-${String(Date.now())}`;
    const laporan = await impor(alice, [baris({ merchant }), baris({ merchant, amount: 60_000 })], false);

    expect(laporan.imported).toBe(2);
    expect(laporan.dryRun).toBe(false);
    expect(await hitung(alice, merchant)).toBe(2);
  });

  it('nasib SETIAP baris dilaporkan dengan nomornya', async () => {
    /* Ringkasan "3 masuk, 1 gagal" tidak dapat dipakai memperbaiki berkas.
       Yang dapat dipakai adalah nomor barisnya. */
    const merchant = `nasib-${String(Date.now())}`;
    const laporan = await impor(
      alice,
      [baris({ merchant }), baris({ merchant, accountId: 'akun-yang-tidak-ada' })],
      false,
    );

    expect(laporan.results).toHaveLength(2);
    expect(laporan.results[0]).toMatchObject({ index: 0, status: 'imported' });
    expect(laporan.results[1]).toMatchObject({ index: 1, status: 'error' });
    expect(laporan.results[1]?.reason).toBeTruthy();
  });

  it('satu baris gagal tidak menjatuhkan sisanya', async () => {
    const merchant = `sebagian-${String(Date.now())}`;
    const laporan = await impor(
      alice,
      [
        baris({ merchant, amount: 11_000 }),
        baris({ merchant, amount: 12_000, categoryId: kategoriPemasukan }),
        baris({ merchant, amount: 13_000 }),
      ],
      false,
    );

    /* Baris kedua memakai kategori pemasukan pada transaksi pengeluaran. */
    expect(laporan.imported).toBe(2);
    expect(laporan.failed).toBe(1);
    expect(await hitung(alice, merchant)).toBe(2);
  });
});

/* ── duplikat ────────────────────────────────────────────────────────── */

describe('duplikat', () => {
  it('MENGUNGGAH BERKAS YANG SAMA DUA KALI TIDAK MENGGANDAKAN APA PUN', async () => {
    /*
     * Inilah yang benar-benar dilakukan orang, dan inilah alasan fitur ini
     * ada. Impor tanpa pengenalan duplikat menggandakan separuh pembukuan
     * tanpa memberi satu pun tanda.
     */
    const merchant = `dua-kali-${String(Date.now())}`;
    const berkas = [
      baris({ merchant, amount: 21_000 }),
      baris({ merchant, amount: 22_000 }),
      baris({ merchant, amount: 23_000 }),
    ];

    const pertama = await impor(alice, berkas, false);
    expect(pertama.imported).toBe(3);

    const kedua = await impor(alice, berkas, false);
    expect(kedua.imported).toBe(0);
    expect(kedua.duplicate).toBe(3);

    expect(await hitung(alice, merchant)).toBe(3);
  });

  it('kembaran DI DALAM satu berkas ikut tertangkap', async () => {
    const merchant = `kembar-${String(Date.now())}`;
    const laporan = await impor(alice, [baris({ merchant }), baris({ merchant })], false);

    expect(laporan.imported).toBe(1);
    expect(laporan.duplicate).toBe(1);
    expect(await hitung(alice, merchant)).toBe(1);
  });

  it('jam yang berbeda pada HARI yang sama tetap duplikat', async () => {
    /* Berkas yang sama diunduh ulang sering membawa cap waktu berbeda
       beberapa detik. Dua baris yang berbeda tiga detik adalah baris yang
       sama. */
    const merchant = `jam-${String(Date.now())}`;
    await impor(alice, [baris({ merchant, occurredAt: SAAT })], false);
    const lagi = await impor(alice, [baris({ merchant, occurredAt: SAAT + 3_600_000 })], false);

    expect(lagi.duplicate).toBe(1);
    expect(await hitung(alice, merchant)).toBe(1);
  });

  it('HARI yang berbeda bukan duplikat', async () => {
    const merchant = `hari-${String(Date.now())}`;
    await impor(alice, [baris({ merchant, occurredAt: SAAT })], false);
    const besok = await impor(alice, [baris({ merchant, occurredAt: SAAT + HARI })], false);

    expect(besok.imported).toBe(1);
    expect(await hitung(alice, merchant)).toBe(2);
  });

  it('merchant yang berbeda bukan duplikat', async () => {
    /* Dua transaksi Rp 25.000 di warung berbeda pada hari yang sama adalah
       dua transaksi. Menganggapnya satu membuat yang kedua hilang diam-diam —
       jauh lebih buruk daripada satu baris kembar yang terlihat. */
    const tanda = String(Date.now());
    await impor(alice, [baris({ merchant: `warung-a-${tanda}`, amount: 25_000 })], false);
    const lain = await impor(alice, [baris({ merchant: `warung-b-${tanda}`, amount: 25_000 })], false);

    expect(lain.imported).toBe(1);
  });

  it('perbandingan merchant mengabaikan huruf besar dan spasi tepi', async () => {
    const merchant = `Kasus-${String(Date.now())}`;
    await impor(alice, [baris({ merchant })], false);
    const lagi = await impor(alice, [baris({ merchant: `  ${merchant.toUpperCase()}  ` })], false);

    expect(lagi.duplicate).toBe(1);
  });

  it('pratinjau menandai duplikat tanpa menulis', async () => {
    const merchant = `lihat-dulu-${String(Date.now())}`;
    await impor(alice, [baris({ merchant })], false);

    const lihat = await impor(alice, [baris({ merchant }), baris({ merchant, amount: 99_000 })]);
    expect(lihat.duplicate).toBe(1);
    expect(lihat.imported).toBe(1);
    expect(await hitung(alice, merchant)).toBe(1);
  });
});

/* ── batas dan kepemilikan ───────────────────────────────────────────── */

describe('batas dan kepemilikan', () => {
  it('tidak bisa menulis ke dompet orang lain', async () => {
    const laporan = await impor(bob, [baris({ accountId: dompetAlice })], false);
    expect(laporan.imported).toBe(0);
    expect(laporan.failed).toBe(1);
  });

  it('menolak berkas yang melampaui batas baris', async () => {
    const res = await api(alice, 'POST', '/v1/transactions/import', {
      dryRun: true,
      rows: Array.from({ length: MAX_ROWS + 1 }, () => baris()),
    });
    expect(res.statusCode).toBe(422);
  });

  it('menerima tepat sebanyak batasnya', async () => {
    const merchant = `batas-${String(Date.now())}`;
    const laporan = await impor(
      alice,
      Array.from({ length: MAX_ROWS }, (_, i) => baris({ merchant, amount: 1_000 + i })),
    );
    expect(laporan.total).toBe(MAX_ROWS);
    expect(laporan.imported).toBe(MAX_ROWS);
  }, 60_000);
});
