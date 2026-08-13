import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';

/**
 * Jendela perhitungan anggaran pada halaman Wawasan.
 *
 * ── CACAT YANG DIJAGA ───────────────────────────────────────────────────
 *
 * `insight/service.ts` menghitung "terpakai" dengan SATU jendela bergulir 30
 * hari untuk semua anggaran, lalu menyebut hasilnya "% batas periode berjalan".
 * Terukur di peramban pada akun demo:
 *
 *   halaman Anggaran : Belanja Rp 1.739.000 / Rp 1.200.000  (145%)
 *   halaman Wawasan  : "Sudah Rp 2.049.000 dari batas Rp 1.200.000" (171%)
 *
 * Satu anggaran, dua angka, keduanya mengaku periode berjalan.
 *
 * Bagi anggaran MINGGUAN akibatnya bukan sekadar tidak konsisten: pengeluaran
 * sebulan diadu dengan batas sepekan, jadi anggaran mingguan yang sehat pun
 * dilaporkan jebol SELAMANYA. Peringatan yang selalu menyala berhenti dibaca,
 * dan ia menyeret seluruh halaman ikut tidak dipercaya.
 *
 * ── MENGAPA UJI INTEGRASI, BUKAN UNIT ───────────────────────────────────
 *
 * Cacatnya ada pada RENTANG TANGGAL yang dikirim ke basis data. Fungsi murni
 * tidak dapat melihatnya — seluruh uji wawasan yang sudah ada murni, dan tidak
 * satu pun menangkapnya. PGlite adalah PostgreSQL sungguhan, jadi penyaringan
 * tanggalnya benar-benar dijalankan.
 */

let h: Harness;

const SANDI = 'kantongz-sandi-kuat';
const HARI = 86_400_000;

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

function req(
  method: 'GET' | 'POST',
  url: string,
  token: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function sesi(email: string): Promise<string> {
  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { fullName: 'Uji Anggaran', email, password: SANDI, device: DEVICE },
  });
  const ticket = reg.json<{ data: { ticket: string } }>().data.ticket;
  const verify = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { ticket, code: h.lastCode()?.code, device: DEVICE },
  });
  return verify.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken;
}

/** Kategori pengeluaran sistem mana pun — isinya tidak penting, periodenya yang diuji. */
async function kategoriPengeluaran(token: string): Promise<string> {
  const res = await req('GET', '/v1/categories', token);
  const found = res.json<{ data: { id: string; kind: string }[] }>().data.find(
    (c) => c.kind === 'expense',
  );
  if (!found) throw new Error('tidak ada kategori pengeluaran');
  return found.id;
}

describe('terpakai dihitung per periode anggaran, bukan 30 hari bergulir', () => {
  it('anggaran MINGGUAN tidak dilaporkan jebol oleh belanja 20 hari lalu', async () => {
    const token = await sesi('jendela-mingguan@contoh.id');
    const categoryId = await kategoriPengeluaran(token);

    const akun = await req('POST', '/v1/accounts', token, {
      name: 'Dompet Jendela',
      kind: 'cash',
      openingBalance: 10_000_000,
    });
    const accountId = akun.json<{ data: { id: string } }>().data.id;

    /*
     * Satu belanja besar 20 hari lalu: DI DALAM jendela 30 hari yang lama, dan
     * DI LUAR pekan berjalan. Inilah satu-satunya transaksi pengguna ini, jadi
     * terpakai pekan ini tepat NOL.
     */
    await req('POST', '/v1/transactions', token, {
      accountId,
      kind: 'expense',
      amount: 5_000_000,
      categoryId,
      occurredAt: Date.now() - 20 * HARI,
      merchant: 'Belanja lama',
    });

    await req('POST', '/v1/budgets', token, {
      categoryId,
      amount: 500_000,
      period: 'weekly',
    });

    const insights = await req('GET', '/v1/insights', token);
    expect(insights.statusCode).toBe(200);

    const risiko = insights
      .json<{ data: { insights: { kind: string; amount: number }[] } }>()
      .data.insights.filter((i) => i.kind === 'budget_risk');

    /* Nol pengeluaran pekan ini terhadap batas 500.000 — tidak ada yang perlu
       diperingatkan. Sebelum perbaikan, 5.000.000 masuk hitungan dan wawasan
       ini muncul sebagai `critical`. */
    expect(risiko).toHaveLength(0);
  }, 40_000);

  it('angka Wawasan sama persis dengan angka /v1/budgets', async () => {
    const token = await sesi('jendela-cocok@contoh.id');
    const categoryId = await kategoriPengeluaran(token);

    const akun = await req('POST', '/v1/accounts', token, {
      name: 'Dompet Cocok',
      kind: 'cash',
      openingBalance: 20_000_000,
    });
    const accountId = akun.json<{ data: { id: string } }>().data.id;

    /* Satu di dalam bulan berjalan, satu berumur 28 hari — persis bentuk yang
       membuat kedua halaman berselisih Rp 310.000 pada akun demo. */
    for (const [amount, umur] of [
      [900_000, 0],
      [310_000, 28],
    ] as const) {
      await req('POST', '/v1/transactions', token, {
        accountId,
        kind: 'expense',
        amount,
        categoryId,
        occurredAt: Date.now() - umur * HARI,
      });
    }

    await req('POST', '/v1/budgets', token, {
      categoryId,
      amount: 1_000_000,
      period: 'monthly',
    });

    const anggaran = await req('GET', '/v1/budgets', token);
    const spent = anggaran.json<{ data: { categoryId: string; spent: number }[] }>().data
      .find((b) => b.categoryId === categoryId)?.spent;
    expect(spent).toBeDefined();

    const insights = await req('GET', '/v1/insights', token);
    const risiko = insights
      .json<{ data: { insights: { kind: string; amount: number; categoryId: string | null }[] } }>()
      .data.insights.find((i) => i.kind === 'budget_risk' && i.categoryId === categoryId);

    /* Kalau wawasannya muncul, nominalnya WAJIB nominal yang sama. Dua angka
       untuk satu anggaran adalah cacatnya, bukan selera penyajian. */
    if (risiko) expect(risiko.amount).toBe(spent);
  }, 40_000);
});
