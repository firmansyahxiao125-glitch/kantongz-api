import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  Budget,
  Category,
  DashboardSummary,
  Goal,
  Transaction,
  TransactionPage,
  WalletAccount,
} from '../../../contracts/ledger.js';
import type { Session } from '../../../contracts/auth.js';
import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';

/**
 * Uji integrasi buku besar terhadap PostgreSQL sungguhan.
 *
 * Dua pengguna dibuat dengan sengaja: separuh dari yang diuji di sini bukan
 * "apakah angkanya benar" melainkan "apakah angka milik orang lain tidak
 * pernah terlihat".
 */

let h: Harness;
let alice = '';
let bob = '';

const PASSWORD = 'kantongz-sandi-kuat';
const HARI = 86_400_000;

beforeAll(async () => {
  h = await createHarness();
  alice = await masuk('alice@contoh.id');
  bob = await masuk('bob@contoh.id');
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

/* ── kepemilikan ─────────────────────────────────────────────────────── */

describe('otorisasi', () => {
  it('menolak setiap rute tanpa token', async () => {
    for (const url of ['/v1/accounts', '/v1/transactions', '/v1/budgets', '/v1/goals', '/v1/dashboard']) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('tidak pernah menampilkan dompet milik pengguna lain', async () => {
    const milikAlice = await data<WalletAccount>(
      api(alice, 'POST', '/v1/accounts', { name: 'Rahasia Alice', kind: 'bank' }),
    );

    const dompetBob = await data<WalletAccount[]>(api(bob, 'GET', '/v1/accounts'));
    expect(dompetBob.map((a) => a.id)).not.toContain(milikAlice.id);

    /* Bob mengetahui id-nya dan tetap tidak bisa menyentuhnya. `not_found`,
       bukan `forbidden` — membedakan keduanya memberi tahu Bob id mana yang
       benar-benar ada. */
    const ubah = await api(bob, 'PATCH', `/v1/accounts/${milikAlice.id}`, { name: 'Dibajak' });
    expect(ubah.statusCode).toBe(404);
  }, 30_000);
});

/* ── dompet dan saldo ────────────────────────────────────────────────── */

describe('dompet', () => {
  let kas = '';
  let bank = '';

  it('membuat dompet dengan saldo awal', async () => {
    const a = await data<WalletAccount>(
      api(alice, 'POST', '/v1/accounts', {
        name: 'Kas',
        kind: 'cash',
        openingBalance: 1_000_000,
        color: '#22c55e',
      }),
    );
    const b = await data<WalletAccount>(
      api(alice, 'POST', '/v1/accounts', { name: 'Bank', kind: 'bank', openingBalance: 5_000_000 }),
    );

    kas = a.id;
    bank = b.id;

    expect(a.balance).toBe(1_000_000);
    expect(a.currency).toBe('IDR');
  }, 30_000);

  it('menghitung saldo dari buku, bukan dari kolom tersimpan', async () => {
    await data(
      api(alice, 'POST', '/v1/transactions', {
        accountId: kas,
        kind: 'expense',
        amount: 250_000,
        occurredAt: Date.now(),
      }),
    );
    await data(
      api(alice, 'POST', '/v1/transactions', {
        accountId: kas,
        kind: 'income',
        amount: 100_000,
        occurredAt: Date.now(),
      }),
    );

    const dompet = await data<WalletAccount[]>(api(alice, 'GET', '/v1/accounts'));
    expect(dompet.find((a) => a.id === kas)?.balance).toBe(1_000_000 - 250_000 + 100_000);
  }, 30_000);

  it('transfer memindahkan saldo tanpa mengubah total', async () => {
    const sebelum = await data<WalletAccount[]>(api(alice, 'GET', '/v1/accounts'));
    const totalSebelum = sebelum.reduce((t, a) => t + a.balance, 0);

    await data(
      api(alice, 'POST', '/v1/transactions', {
        accountId: bank,
        counterAccountId: kas,
        kind: 'transfer',
        amount: 750_000,
        occurredAt: Date.now(),
      }),
    );

    const sesudah = await data<WalletAccount[]>(api(alice, 'GET', '/v1/accounts'));
    const totalSesudah = sesudah.reduce((t, a) => t + a.balance, 0);

    /* Inti dari mengapa transfer adalah SATU baris: tidak ada keadaan di mana
       satu sisi tercatat dan sisi lainnya tidak. */
    expect(totalSesudah).toBe(totalSebelum);
    expect(sesudah.find((a) => a.id === bank)?.balance).toBe(
      (sebelum.find((a) => a.id === bank)?.balance ?? 0) - 750_000,
    );
    expect(sesudah.find((a) => a.id === kas)?.balance).toBe(
      (sebelum.find((a) => a.id === kas)?.balance ?? 0) + 750_000,
    );
  }, 30_000);

  it('menolak transfer ke dompet yang sama', async () => {
    const res = await api(alice, 'POST', '/v1/transactions', {
      accountId: kas,
      counterAccountId: kas,
      kind: 'transfer',
      amount: 10_000,
      occurredAt: Date.now(),
    });
    expect(res.statusCode).toBe(422);
  });

  it('menolak dompet tujuan pada transaksi yang bukan transfer', async () => {
    const res = await api(alice, 'POST', '/v1/transactions', {
      accountId: kas,
      counterAccountId: bank,
      kind: 'expense',
      amount: 10_000,
      occurredAt: Date.now(),
    });
    expect(res.statusCode).toBe(422);
  });

  it('menolak jumlah nol dan negatif', async () => {
    for (const amount of [0, -5000]) {
      const res = await api(alice, 'POST', '/v1/transactions', {
        accountId: kas,
        kind: 'expense',
        amount,
        occurredAt: Date.now(),
      });
      expect(res.statusCode, String(amount)).toBe(422);
    }
  });

  it('menolak dompet milik pengguna lain sebagai sumber', async () => {
    const res = await api(bob, 'POST', '/v1/transactions', {
      accountId: kas,
      kind: 'expense',
      amount: 10_000,
      occurredAt: Date.now(),
    });
    expect(res.statusCode).toBe(404);
  });
});

/* ── kategori ────────────────────────────────────────────────────────── */

describe('kategori', () => {
  it('menyediakan kategori bawaan untuk semua pengguna', async () => {
    const milikAlice = await data<Category[]>(api(alice, 'GET', '/v1/categories'));
    const milikBob = await data<Category[]>(api(bob, 'GET', '/v1/categories'));

    const bawaan = milikAlice.filter((c) => c.system);
    expect(bawaan.length).toBeGreaterThan(10);
    /* Baris yang SAMA, bukan salinan per pengguna. */
    expect(milikBob.filter((c) => c.system).map((c) => c.id).sort()).toEqual(
      bawaan.map((c) => c.id).sort(),
    );
  }, 30_000);

  it('menolak pengubahan kategori bawaan', async () => {
    const list = await data<Category[]>(api(alice, 'GET', '/v1/categories'));
    const bawaan = list.find((c) => c.system);

    const res = await api(alice, 'PATCH', `/v1/categories/${bawaan?.id ?? ''}`, {
      name: 'Diubah diam-diam',
    });
    expect(res.statusCode).toBe(404);
  }, 30_000);

  it('menolak kategori yang jenisnya tidak cocok dengan transaksi', async () => {
    const list = await data<Category[]>(api(alice, 'GET', '/v1/categories'));
    const pemasukan = list.find((c) => c.kind === 'income');
    const dompet = await data<WalletAccount[]>(api(alice, 'GET', '/v1/accounts'));

    const res = await api(alice, 'POST', '/v1/transactions', {
      accountId: dompet[0]?.id,
      categoryId: pemasukan?.id,
      kind: 'expense',
      amount: 10_000,
      occurredAt: Date.now(),
    });
    expect(res.statusCode).toBe(422);
  }, 30_000);
});

/* ── daftar dan halaman ──────────────────────────────────────────────── */

describe('transaksi', () => {
  it('memberi halaman dengan kursor yang stabil', async () => {
    const dompet = await data<WalletAccount[]>(api(bob, 'GET', '/v1/accounts'));
    const akun =
      dompet[0] ??
      (await data<WalletAccount>(api(bob, 'POST', '/v1/accounts', { name: 'Bob', kind: 'cash' })));

    for (let i = 0; i < 12; i += 1) {
      await data(
        api(bob, 'POST', '/v1/transactions', {
          accountId: akun.id,
          kind: 'expense',
          amount: 10_000 + i,
          occurredAt: Date.now() - i * HARI,
        }),
      );
    }

    const satu = await data<TransactionPage>(api(bob, 'GET', '/v1/transactions?limit=5'));
    expect(satu.items).toHaveLength(5);
    expect(satu.nextCursor).not.toBeNull();

    const dua = await data<TransactionPage>(
      api(bob, 'GET', `/v1/transactions?limit=5&cursor=${satu.nextCursor ?? ''}`),
    );

    /* Tidak ada baris yang muncul di dua halaman — itulah alasan kursor dipakai
       alih-alih OFFSET. */
    const ids = new Set(satu.items.map((t) => t.id));
    expect(dua.items.some((t) => ids.has(t.id))).toBe(false);
  }, 60_000);

  it('menyaring berdasarkan jenis', async () => {
    const page = await data<TransactionPage>(api(bob, 'GET', '/v1/transactions?kind=income'));
    expect(page.items.every((t) => t.kind === 'income')).toBe(true);
  }, 30_000);

  it('menghapus lunak: hilang dari daftar, saldo ikut menyesuaikan', async () => {
    const dompet = await data<WalletAccount[]>(api(alice, 'GET', '/v1/accounts'));
    const akun = dompet[0];

    const trx = await data<Transaction>(
      api(alice, 'POST', '/v1/transactions', {
        accountId: akun?.id,
        kind: 'expense',
        amount: 33_000,
        occurredAt: Date.now(),
      }),
    );

    const sesudahTambah = await data<WalletAccount[]>(api(alice, 'GET', '/v1/accounts'));
    await data(api(alice, 'DELETE', `/v1/transactions/${trx.id}`));
    const sesudahHapus = await data<WalletAccount[]>(api(alice, 'GET', '/v1/accounts'));

    expect(
      (sesudahHapus.find((a) => a.id === akun?.id)?.balance ?? 0) -
        (sesudahTambah.find((a) => a.id === akun?.id)?.balance ?? 0),
    ).toBe(33_000);

    const page = await data<TransactionPage>(api(alice, 'GET', '/v1/transactions?limit=100'));
    expect(page.items.map((t) => t.id)).not.toContain(trx.id);

    /* Menghapus dua kali bukan galat server — ia hanya sudah tidak ada. */
    const lagi = await api(alice, 'DELETE', `/v1/transactions/${trx.id}`);
    expect(lagi.statusCode).toBe(404);
  }, 60_000);
});

/* ── anggaran ────────────────────────────────────────────────────────── */

describe('anggaran', () => {
  it('menghitung terpakai dari pengeluaran periode berjalan', async () => {
    const list = await data<Category[]>(api(alice, 'GET', '/v1/categories'));
    const kategori = list.find((c) => c.kind === 'expense' && c.name === 'Makan & Minum');
    const dompet = await data<WalletAccount[]>(api(alice, 'GET', '/v1/accounts'));

    await data(
      api(alice, 'POST', '/v1/transactions', {
        accountId: dompet[0]?.id,
        categoryId: kategori?.id,
        kind: 'expense',
        amount: 400_000,
        occurredAt: Date.now(),
      }),
    );

    const anggaran = await data<Budget>(
      api(alice, 'POST', '/v1/budgets', {
        categoryId: kategori?.id,
        period: 'monthly',
        amount: 1_500_000,
      }),
    );

    expect(anggaran.spent).toBe(400_000);

    const semua = await data<Budget[]>(api(alice, 'GET', '/v1/budgets'));
    expect(semua.find((b) => b.id === anggaran.id)?.spent).toBe(400_000);
  }, 60_000);

  it('menolak anggaran pada kategori pemasukan', async () => {
    const list = await data<Category[]>(api(alice, 'GET', '/v1/categories'));
    const pemasukan = list.find((c) => c.kind === 'income');

    const res = await api(alice, 'POST', '/v1/budgets', {
      categoryId: pemasukan?.id,
      amount: 100_000,
    });
    expect(res.statusCode).toBe(422);
  }, 30_000);
});

/* ── tujuan ──────────────────────────────────────────────────────────── */

describe('tujuan', () => {
  it('menambah tabungan dan menandai tercapai', async () => {
    const tujuan = await data<Goal>(
      api(alice, 'POST', '/v1/goals', { name: 'Dana Darurat', targetAmount: 1_000_000 }),
    );
    expect(tujuan.savedAmount).toBe(0);
    expect(tujuan.achieved).toBe(false);

    const sebagian = await data<Goal>(
      api(alice, 'POST', `/v1/goals/${tujuan.id}/contribute`, { amount: 600_000 }),
    );
    expect(sebagian.savedAmount).toBe(600_000);
    expect(sebagian.achieved).toBe(false);

    const penuh = await data<Goal>(
      api(alice, 'POST', `/v1/goals/${tujuan.id}/contribute`, { amount: 400_000 }),
    );
    expect(penuh.savedAmount).toBe(1_000_000);
    expect(penuh.achieved).toBe(true);

    /* Penarikan kembali membatalkan status tercapai — tujuan yang tetap
       "tercapai" setelah uangnya diambil adalah kebohongan yang menenangkan. */
    const ditarik = await data<Goal>(
      api(alice, 'POST', `/v1/goals/${tujuan.id}/contribute`, { amount: -500_000 }),
    );
    expect(ditarik.savedAmount).toBe(500_000);
    expect(ditarik.achieved).toBe(false);
  }, 60_000);

  it('tidak pernah membiarkan tabungan menjadi negatif', async () => {
    const tujuan = await data<Goal>(
      api(alice, 'POST', '/v1/goals', { name: 'Liburan', targetAmount: 500_000 }),
    );

    const hasil = await data<Goal>(
      api(alice, 'POST', `/v1/goals/${tujuan.id}/contribute`, { amount: -999_999 }),
    );
    expect(hasil.savedAmount).toBe(0);
  }, 30_000);

  it('menolak tujuan milik pengguna lain', async () => {
    const tujuan = await data<Goal>(
      api(alice, 'POST', '/v1/goals', { name: 'Milik Alice', targetAmount: 100_000 }),
    );

    const res = await api(bob, 'POST', `/v1/goals/${tujuan.id}/contribute`, { amount: 50_000 });
    expect(res.statusCode).toBe(404);
  }, 30_000);
});

/* ── dasbor ──────────────────────────────────────────────────────────── */

describe('dasbor', () => {
  it('merangkum kekayaan bersih, arus kas, dan kategori teratas', async () => {
    const ringkasan = await data<DashboardSummary>(api(alice, 'GET', '/v1/dashboard'));
    const dompet = await data<WalletAccount[]>(api(alice, 'GET', '/v1/accounts'));

    expect(ringkasan.netWorth).toBe(dompet.reduce((t, a) => t + a.balance, 0));
    expect(ringkasan.monthExpense).toBeGreaterThan(0);
    expect(ringkasan.topCategories.length).toBeGreaterThan(0);
    expect(ringkasan.recent.length).toBeGreaterThan(0);
    expect(ringkasan.cashflow.every((p) => p.income >= 0 && p.expense >= 0)).toBe(true);
  }, 60_000);

  it('tidak mencampur data antar pengguna', async () => {
    const punyaAlice = await data<DashboardSummary>(api(alice, 'GET', '/v1/dashboard'));
    const punyaBob = await data<DashboardSummary>(api(bob, 'GET', '/v1/dashboard'));

    const idAlice = new Set(punyaAlice.accounts.map((a) => a.id));
    expect(punyaBob.accounts.some((a) => idAlice.has(a.id))).toBe(false);
    expect(punyaAlice.netWorth).not.toBe(punyaBob.netWorth);
  }, 60_000);

  it('transfer tidak dihitung sebagai pemasukan maupun pengeluaran', async () => {
    const sebelum = await data<DashboardSummary>(api(alice, 'GET', '/v1/dashboard'));
    const dompet = await data<WalletAccount[]>(api(alice, 'GET', '/v1/accounts'));
    const [a, b] = dompet;

    await data(
      api(alice, 'POST', '/v1/transactions', {
        accountId: a?.id,
        counterAccountId: b?.id,
        kind: 'transfer',
        amount: 123_456,
        occurredAt: Date.now(),
      }),
    );

    const sesudah = await data<DashboardSummary>(api(alice, 'GET', '/v1/dashboard'));

    /* Memindahkan uang ke dompet sendiri bukan belanja. Menghitungnya membuat
       setiap pengguna yang menabung terlihat boros dua kali lipat. */
    expect(sesudah.monthExpense).toBe(sebelum.monthExpense);
    expect(sesudah.monthIncome).toBe(sebelum.monthIncome);
    expect(sesudah.netWorth).toBe(sebelum.netWorth);
  }, 60_000);
});
