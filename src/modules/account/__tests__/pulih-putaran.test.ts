import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../../../contracts/auth.js';
import type { Budget, Goal, Transaction, WalletAccount } from '../../../contracts/ledger.js';
import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';

/**
 * F2 — PUTARAN PENUH: ekspor lalu pulihkan, dan angkanya harus cocok.
 *
 * ── MENGAPA PUTARAN, BUKAN DUA UJI TERPISAH ────────────────────────────
 *
 * Ekspor yang benar dan pemulihan yang benar tetap dapat gagal BERSAMA-SAMA
 * kalau keduanya sepakat pada bentuk yang salah. Satu-satunya cara mengetahui
 * berkas ekspor benar-benar berguna adalah memakainya untuk membangun ulang
 * pembukuan, lalu membandingkan hasilnya dengan aslinya.
 *
 * Ini juga satu-satunya uji yang membuktikan janji terpenting fitur ini:
 * data pengguna dapat dibawa pergi DAN dibawa kembali. Ekspor tanpa
 * pemulihan hanyalah unduhan.
 */

let h: Harness;
let asli = '';
let baru = '';
let kosong = '';

const PASSWORD = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();
  asli = await masuk('pulih-asli@contoh.id');
  baru = await masuk('pulih-baru@contoh.id');
  kosong = await masuk('pulih-kosong@contoh.id');
}, 150_000);

afterAll(async () => {
  await h.close();
});

async function masuk(email: string): Promise<string> {
  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { fullName: 'Penguji', email, password: PASSWORD, device: DEVICE },
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
  return verify.json<{ data: Session }>().data.tokens.accessToken;
}

function api(
  token: string,
  method: 'GET' | 'POST',
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

async function data<T>(res: Promise<LightMyRequestResponse>): Promise<T> {
  const r = await res;
  if (r.statusCode >= 400) throw new Error(`${String(r.statusCode)} ${r.body}`);
  return r.json<{ data: T }>().data;
}

describe('F2 · ekspor lalu pulih', () => {
  let ekspor: Record<string, unknown>;

  beforeAll(async () => {
    /* Pembukuan kecil tetapi LENGKAP: setiap jenis baris yang ikut diekspor
       diwakili, termasuk transfer antar-dompet — bentuk yang paling mudah
       rusak saat id dipetakan ulang, karena ia menunjuk DUA dompet. */
    const kas = await data<WalletAccount>(
      api(asli, 'POST', '/v1/accounts', { name: 'Kas Asli', kind: 'cash' }),
    );
    const bank = await data<WalletAccount>(
      api(asli, 'POST', '/v1/accounts', { name: 'Bank Asli', kind: 'bank' }),
    );

    const kategori = await data<{ id: string }>(
      api(asli, 'POST', '/v1/categories', {
        name: 'Kopi Asli',
        kind: 'expense',
        icon: 'coffee',
        color: '#c89440',
      }),
    );

    await data<Transaction>(
      api(asli, 'POST', '/v1/transactions', {
        accountId: kas.id,
        categoryId: kategori.id,
        kind: 'expense',
        amount: 25_000,
        occurredAt: Date.UTC(2026, 7, 1),
        merchant: 'Warung Asli',
      }),
    );

    await data<Transaction>(
      api(asli, 'POST', '/v1/transactions', {
        accountId: kas.id,
        counterAccountId: bank.id,
        kind: 'transfer',
        amount: 100_000,
        occurredAt: Date.UTC(2026, 7, 2),
      }),
    );

    await data<Budget>(
      api(asli, 'POST', '/v1/budgets', {
        categoryId: kategori.id,
        period: 'monthly',
        amount: 500_000,
      }),
    );

    await data<Goal>(
      api(asli, 'POST', '/v1/goals', { name: 'Dana Asli', targetAmount: 5_000_000 }),
    );

    ekspor = await data<Record<string, unknown>>(api(asli, 'GET', '/v1/account/export'));
  }, 150_000);

  it('pratinjau adalah BAWAANNYA — tanpa bendera, tidak satu baris pun ditulis', async () => {
    const hasil = await data<{ pratinjau: boolean; jumlah: { wallets: number } }>(
      api(baru, 'POST', '/v1/account/restore', { data: ekspor }),
    );

    expect(hasil.pratinjau).toBe(true);
    expect(hasil.jumlah.wallets).toBe(2);

    /* Yang menentukan bukan benderanya melainkan akibatnya: pembukuannya
       harus masih kosong. */
    const dompet = await data<WalletAccount[]>(api(baru, 'GET', '/v1/accounts'));
    expect(dompet).toHaveLength(0);
  }, 60_000);

  it('memulihkan seluruh pembukuan ke akun yang kosong', async () => {
    const hasil = await data<{ pratinjau: boolean }>(
      api(baru, 'POST', '/v1/account/restore', { data: ekspor, dryRun: false }),
    );
    expect(hasil.pratinjau).toBe(false);

    const dompet = await data<WalletAccount[]>(api(baru, 'GET', '/v1/accounts'));
    expect(dompet.map((d) => d.name).sort()).toEqual(['Bank Asli', 'Kas Asli']);

    const tujuan = await data<Goal[]>(api(baru, 'GET', '/v1/goals'));
    expect(tujuan.map((g) => g.name)).toContain('Dana Asli');

    const anggaran = await data<Budget[]>(api(baru, 'GET', '/v1/budgets'));
    expect(anggaran).toHaveLength(1);
    expect(anggaran[0]?.amount).toBe(500_000);
  }, 120_000);

  it('TRANSFER tetap menunjuk kedua dompet yang benar sesudah id dipetakan ulang', async () => {
    const halaman = await data<{ items: Transaction[] }>(
      api(baru, 'GET', '/v1/transactions?limit=50'),
    );
    const transfer = halaman.items.find((t) => t.kind === 'transfer');
    const dompet = await data<WalletAccount[]>(api(baru, 'GET', '/v1/accounts'));
    const idBaru = new Set(dompet.map((d) => d.id));

    expect(transfer).toBeDefined();
    expect(idBaru.has(transfer?.accountId ?? '')).toBe(true);
    expect(idBaru.has(transfer?.counterAccountId ?? '')).toBe(true);
  }, 60_000);

  it('id LAMA tidak satu pun bertahan — jejak akun lama tidak ikut terbawa', async () => {
    const dompetLama = (ekspor.wallets as { id: string }[]).map((w) => w.id);
    const dompetBaru = await data<WalletAccount[]>(api(baru, 'GET', '/v1/accounts'));

    for (const id of dompetBaru.map((d) => d.id)) {
      expect(dompetLama).not.toContain(id);
    }
  }, 60_000);

  it('MENOLAK memulihkan ke pembukuan yang sudah berisi', async () => {
    /* Pemulihan bukan penggabungan. Menuangkan berkas ekspor ke atas
       pembukuan yang sudah punya isi menghasilkan setiap baris DUA KALI, dan
       tidak ada tombol untuk membatalkannya. */
    const res = await api(baru, 'POST', '/v1/account/restore', {
      data: ekspor,
      dryRun: false,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('kosong');
  }, 60_000);

  it('menolak berkas dari versi yang tidak dikenali', async () => {
    const res = await api(kosong, 'POST', '/v1/account/restore', {
      data: { ...ekspor, schemaVersion: 99 },
      dryRun: false,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const dompet = await data<WalletAccount[]>(api(kosong, 'GET', '/v1/accounts'));
    expect(dompet).toHaveLength(0);
  }, 60_000);
});
