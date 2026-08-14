import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../../../contracts/auth.js';
import type {
  Category,
  RecurringRule,
  TransactionPage,
  WalletAccount,
} from '../../../contracts/ledger.js';
import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';
import { toDateString } from '../periods.js';
import { runDueRecurring, type RunSummary } from '../recurring.js';

/**
 * Aturan berulang terhadap PostgreSQL sungguhan.
 *
 * Kalender murninya sudah diuji sendiri di `schedule.test.ts`. Yang diuji di
 * sini adalah yang hanya dapat salah ketika ada basis data: kepemilikan,
 * pengejaran ketertinggalan, dan — yang paling penting — bahwa satu tagihan
 * tidak pernah tercatat dua kali.
 */

let h: Harness;
let alice = '';
let bob = '';
let dompetAlice = '';
let dompetBob = '';
let kategoriAlice = '';

const PASSWORD = 'kantongz-sandi-kuat';
const HARI = 86_400_000;

beforeAll(async () => {
  h = await createHarness();
  alice = await masuk('rec-alice@contoh.id');
  bob = await masuk('rec-bob@contoh.id');

  dompetAlice = (
    await data<WalletAccount>(
      api(alice, 'POST', '/v1/accounts', { name: 'Bank Berulang', kind: 'bank' }),
    )
  ).id;
  dompetBob = (
    await data<WalletAccount>(api(bob, 'POST', '/v1/accounts', { name: 'Bank Bob', kind: 'bank' }))
  ).id;

  const kategori = await data<Category[]>(api(alice, 'GET', '/v1/categories'));
  kategoriAlice = kategori.find((c) => c.kind === 'expense')?.id ?? '';
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

const hariIni = (geser = 0): string => toDateString(new Date(Date.now() + geser * HARI));

function aturan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Langganan Uji',
    accountId: dompetAlice,
    categoryId: kategoriAlice,
    kind: 'expense',
    amount: 55_000,
    cadence: 'daily',
    interval: 1,
    startsOn: hariIni(),
    ...over,
  };
}

/** Transaksi milik satu aturan, dikenali dari merchant-nya. */
async function hitung(token: string, merchant: string): Promise<number> {
  const halaman = await data<TransactionPage>(api(token, 'GET', '/v1/transactions?limit=100'));
  return halaman.items.filter((t) => t.merchant === merchant).length;
}

/* ── kepemilikan ─────────────────────────────────────────────────────── */

describe('kepemilikan', () => {
  it('menolak tanpa token', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/recurring' });
    expect(res.statusCode).toBe(401);
  });

  it('tidak pernah menampilkan aturan milik pengguna lain', async () => {
    const milikAlice = await data<RecurringRule>(
      api(alice, 'POST', '/v1/recurring', aturan({ name: 'Rahasia Alice' })),
    );

    const punyaBob = await data<RecurringRule[]>(api(bob, 'GET', '/v1/recurring'));
    expect(punyaBob.map((r) => r.id)).not.toContain(milikAlice.id);

    const hapus = await api(bob, 'DELETE', `/v1/recurring/${milikAlice.id}`);
    expect(hapus.statusCode).toBe(404);
  });

  it('menolak dompet milik pengguna lain', async () => {
    const res = await api(alice, 'POST', '/v1/recurring', aturan({ accountId: dompetBob }));
    expect(res.statusCode).toBe(404);
  });
});

/* ── validasi ────────────────────────────────────────────────────────── */

describe('validasi', () => {
  it('menolak tanggal yang tidak ada', async () => {
    const res = await api(alice, 'POST', '/v1/recurring', aturan({ startsOn: '2026-02-31' }));
    expect(res.statusCode).toBe(422);
  });

  it('menolak tanggal berakhir yang mendahului tanggal mulai', async () => {
    const res = await api(
      alice,
      'POST',
      '/v1/recurring',
      aturan({ startsOn: hariIni(3), endsOn: hariIni(1) }),
    );
    expect(res.statusCode).toBe(422);
  });

  it('menolak tanggal mulai jauh di belakang', async () => {
    /* Aturan harian yang dimulai setahun lalu akan langsung melahirkan ratusan
       transaksi yang tidak pernah diminta siapa pun. */
    const res = await api(alice, 'POST', '/v1/recurring', aturan({ startsOn: hariIni(-400) }));
    expect(res.statusCode).toBe(422);
  });

  it('menerima mundur sedikit — "sewa jatuh tanggal 1, hari ini tanggal 5"', async () => {
    const res = await api(alice, 'POST', '/v1/recurring', aturan({ startsOn: hariIni(-5) }));
    expect(res.statusCode).toBe(201);
  });

  it('menolak transfer tanpa dompet tujuan', async () => {
    const res = await api(alice, 'POST', '/v1/recurring', aturan({ kind: 'transfer' }));
    expect(res.statusCode).toBe(422);
  });

  it('menolak kategori yang jenisnya tidak cocok', async () => {
    const kategori = await data<Category[]>(api(alice, 'GET', '/v1/categories'));
    const pemasukan = kategori.find((c) => c.kind === 'income');
    const res = await api(
      alice,
      'POST',
      '/v1/recurring',
      aturan({ kind: 'expense', categoryId: pemasukan?.id }),
    );
    expect(res.statusCode).toBe(422);
  });

  it('jangkar diambil dari tanggal mulai', async () => {
    const rule = await data<RecurringRule>(
      api(
        alice,
        'POST',
        '/v1/recurring',
        aturan({ cadence: 'monthly', startsOn: hariIni(), name: 'Jangkar' }),
      ),
    );
    expect(rule.nextRunOn).toBe(hariIni());
  });
});

/* ── pencatatan ──────────────────────────────────────────────────────── */

describe('menjalankan yang jatuh tempo', () => {
  it('yang belum jatuh tempo tidak menulis apa pun', async () => {
    const merchant = `belum-${String(Date.now())}`;
    await data<RecurringRule>(
      api(alice, 'POST', '/v1/recurring', aturan({ merchant, startsOn: hariIni(5) })),
    );

    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    expect(await hitung(alice, merchant)).toBe(0);
  });

  it('yang jatuh hari ini menulis tepat satu, tanpa kegagalan diam-diam', async () => {
    const merchant = `hariini-${String(Date.now())}`;
    await data<RecurringRule>(api(alice, 'POST', '/v1/recurring', aturan({ merchant })));

    const hasil = await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    /* `failed` diperiksa, dan itu bukan hiasan: putaran menelan galat tiap
       aturan supaya satu kegagalan tidak menjatuhkan yang lain — tanpa
       memeriksa angka ini, aturan yang SELALU gagal akan lolos sebagai
       "tidak menulis apa-apa" dan terlihat persis seperti belum jatuh tempo. */
    expect(hasil.failed).toBe(0);
    expect(hasil.posted).toBeGreaterThanOrEqual(1);
    expect(await hitung(alice, merchant)).toBe(1);
  });

  it('MENJALANKAN DUA KALI TIDAK MENULIS DUA KALI', async () => {
    /*
     * Uji yang paling penting di berkas ini.
     *
     * Tagihan sewa yang tercatat dua kali baru ketahuan saat saldo tidak lagi
     * cocok, berbulan-bulan kemudian, dan saat itu tidak ada yang tahu harus
     * mencari di mana. Yang menjaganya bukan pemeriksaan di lapisan layanan
     * melainkan indeks unik `(rule_id, occurred_on)`.
     */
    const merchant = `sekali-${String(Date.now())}`;
    await data<RecurringRule>(api(alice, 'POST', '/v1/recurring', aturan({ merchant })));

    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));

    expect(await hitung(alice, merchant)).toBe(1);
  });

  it('memanggil layanannya langsung pun tetap satu', async () => {
    /*
     * Lewat fungsi layanannya, bukan lewat HTTP — jalur yang dipakai pekerja
     * latar. Keduanya wajib sama-sama idempoten.
     *
     * Yang TIDAK dibuktikan di sini: dua proses yang berjalan benar-benar
     * bersamaan. Harness ini memakai PGlite dengan satu koneksi, jadi
     * `Promise.all` di sini hanya akan menyerialkan pernyataannya dan
     * membuktikan sesuatu yang lain. `FOR UPDATE SKIP LOCKED` dibuktikan
     * terhadap PostgreSQL sungguhan di `scripts/security.mjs`.
     */
    const merchant = `layanan-${String(Date.now())}`;
    await data<RecurringRule>(api(alice, 'POST', '/v1/recurring', aturan({ merchant })));

    await runDueRecurring({ db: h.db });
    await runDueRecurring({ db: h.db });

    expect(await hitung(alice, merchant)).toBe(1);
  });

  it('mengejar ketertinggalan sampai hari ini, tidak lebih', async () => {
    const merchant = `kejar-${String(Date.now())}`;
    await data<RecurringRule>(
      api(alice, 'POST', '/v1/recurring', aturan({ merchant, startsOn: hariIni(-4) })),
    );

    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    /* Lima: empat hari yang lewat, ditambah hari ini. */
    expect(await hitung(alice, merchant)).toBe(5);
  });

  it('berhenti di tanggal berakhir', async () => {
    const merchant = `berakhir-${String(Date.now())}`;
    await data<RecurringRule>(
      api(
        alice,
        'POST',
        '/v1/recurring',
        aturan({ merchant, startsOn: hariIni(-4), endsOn: hariIni(-2) }),
      ),
    );

    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    expect(await hitung(alice, merchant)).toBe(3);
  });

  it('transaksinya bertanggal kejadiannya, bukan tanggal ia ditulis', async () => {
    const merchant = `tanggal-${String(Date.now())}`;
    await data<RecurringRule>(
      api(alice, 'POST', '/v1/recurring', aturan({ merchant, startsOn: hariIni(-2) })),
    );

    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    const halaman = await data<TransactionPage>(api(alice, 'GET', '/v1/transactions?limit=100'));
    const tanggal = halaman.items
      .filter((t) => t.merchant === merchant)
      .map((t) => toDateString(new Date(t.occurredAt)))
      .sort();

    expect(tanggal).toEqual([hariIni(-2), hariIni(-1), hariIni()]);
  });

  it('menghitung berapa yang sudah dilahirkan', async () => {
    const merchant = `hitung-${String(Date.now())}`;
    const rule = await data<RecurringRule>(
      api(alice, 'POST', '/v1/recurring', aturan({ merchant, startsOn: hariIni(-2) })),
    );
    expect(rule.postedCount).toBe(0);

    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    const sesudah = await data<RecurringRule[]>(api(alice, 'GET', '/v1/recurring'));
    expect(sesudah.find((r) => r.id === rule.id)?.postedCount).toBe(3);
  });
});

/* ── jeda ────────────────────────────────────────────────────────────── */

describe('jeda', () => {
  it('yang dijeda tidak menulis apa pun', async () => {
    const merchant = `jeda-${String(Date.now())}`;
    const rule = await data<RecurringRule>(
      api(alice, 'POST', '/v1/recurring', aturan({ merchant })),
    );

    await data<RecurringRule>(api(alice, 'POST', `/v1/recurring/${rule.id}/pause`, { paused: true }));
    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));

    expect(await hitung(alice, merchant)).toBe(0);
  });

  it('melanjutkan MELOMPATI yang terlewat, bukan menagih semuanya sekaligus', async () => {
    /* Orang menjeda justru supaya tagihannya tidak terjadi. Melanjutkan lalu
       menerima empat tagihan sekaligus adalah kejutan yang mahal. */
    const merchant = `lanjut-${String(Date.now())}`;
    const rule = await data<RecurringRule>(
      api(alice, 'POST', '/v1/recurring', aturan({ merchant, startsOn: hariIni(-4) })),
    );

    await data<RecurringRule>(api(alice, 'POST', `/v1/recurring/${rule.id}/pause`, { paused: true }));
    const lanjut = await data<RecurringRule>(
      api(alice, 'POST', `/v1/recurring/${rule.id}/pause`, { paused: false }),
    );

    expect(lanjut.paused).toBe(false);
    expect(lanjut.nextRunOn).toBe(hariIni(1));

    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    expect(await hitung(alice, merchant)).toBe(0);
  });
});

/* ── perubahan dan penghapusan ───────────────────────────────────────── */

describe('mengubah dan menghapus', () => {
  it('mengubah TIDAK memundurkan tanggal jalan berikutnya', async () => {
    /*
     * Kalau `nextRunOn` dikembalikan ke tanggal mulai, bulan yang sudah
     * dibayar akan tercatat lagi — dan indeks unik tidak menolaknya, karena
     * irama baru menghasilkan tanggal yang berbeda.
     */
    const merchant = `ubah-${String(Date.now())}`;
    const rule = await data<RecurringRule>(
      api(alice, 'POST', '/v1/recurring', aturan({ merchant, startsOn: hariIni(-3) })),
    );

    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    const sebelum = await hitung(alice, merchant);

    const diubah = await data<RecurringRule>(
      api(
        alice,
        'PUT',
        `/v1/recurring/${rule.id}`,
        aturan({ merchant, startsOn: hariIni(-3), amount: 99_000, name: 'Diubah' }),
      ),
    );
    expect(diubah.amount).toBe(99_000);
    expect(diubah.nextRunOn).toBe(hariIni(1));

    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    expect(await hitung(alice, merchant)).toBe(sebelum);
  });

  it('menghapus aturan TIDAK menghapus transaksi yang sudah terjadi', async () => {
    /* Uang yang sudah keluar tetap keluar. Menghapusnya akan mengubah saldo
       bulan yang sudah ditutup. */
    const merchant = `hapus-${String(Date.now())}`;
    const rule = await data<RecurringRule>(
      api(alice, 'POST', '/v1/recurring', aturan({ merchant })),
    );

    await data<RunSummary>(api(alice, 'POST', '/v1/recurring/run'));
    expect(await hitung(alice, merchant)).toBe(1);

    const hapus = await api(alice, 'DELETE', `/v1/recurring/${rule.id}`);
    expect(hapus.statusCode).toBe(200);
    expect(await hitung(alice, merchant)).toBe(1);
  });
});
