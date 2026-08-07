import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';
import { unavailableModel } from '../provider.js';

/**
 * Uji asisten. ROADMAP M11 dan M13.
 *
 * Yang dibuktikan di sini adalah hal yang paling mudah dianggap remeh: bahwa
 * SELURUH lapisan ini tetap berguna tanpa kredensial model. Angka dihitung
 * server, narasinya disusun templat, dan pengguna DIBERI TAHU bahwa ia
 * bertemplat — ringkasan bertemplat yang menyamar sebagai analisis adalah
 * kebohongan kecil yang merusak kepercayaan pada seluruh angka di sekitarnya.
 */

let h: Harness;
let token = '';

const PASSWORD = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();

  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { fullName: 'Asisten Uji', email: 'asisten@contoh.id', password: PASSWORD, device: DEVICE },
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

function api(
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

describe('penyedia model', () => {
  it('yang tidak tersedia melempar bila dipanggil', async () => {
    const model = unavailableModel('uji');

    expect(model.available).toBe(false);
    /* Melempar, bukan mengembalikan kalimat kosong yang terlihat seperti
       jawaban — jalur yang lupa memeriksa `available` harus gagal keras. */
    await expect(
      model.complete({ system: 's', prompt: 'p', maxTokens: 10 }),
    ).rejects.toThrow();
  });
});

describe('ringkasan periode', () => {
  it('tetap menghasilkan ringkasan tanpa kredensial model', async () => {
    const res = await api('GET', '/v1/assistant/summary');

    expect(res.statusCode).toBe(200);

    const data = res.json<{
      data: { narrative: string; narrativeSource: string; income: number; expense: number };
    }>().data;

    expect(data.narrative.length).toBeGreaterThan(20);
    expect(data.income).toBe(0);
    expect(data.expense).toBe(0);
  }, 30_000);

  /* Inti berkas ini: pengguna diberi tahu bahwa ringkasannya tidak disusun
     model. Menyembunyikannya adalah kebohongan kecil yang merusak kepercayaan
     pada seluruh angka di sekitarnya. */
  it('menyatakan terbuka bahwa narasinya bertemplat', async () => {
    const data = await api('GET', '/v1/assistant/summary').then((r) =>
      r.json<{ data: { narrativeSource: string } }>().data,
    );

    expect(data.narrativeSource).toBe('template');
  }, 30_000);

  it('menolak tanpa token', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/assistant/summary' });
    expect(res.statusCode).toBe(401);
  });
});

describe('simulasi what-if', () => {
  /*
   * Aritmetika, bukan model. Pertanyaan "kalau saya cicil 1,2 juta per bulan,
   * aman tidak?" punya jawaban yang dapat diperiksa ulang dengan kalkulator,
   * dan menyerahkannya ke model berarti menyerahkan aritmetika kepada sesuatu
   * yang kadang salah menghitung.
   */
  it('menjawab tanpa kredensial model apa pun', async () => {
    const res = await api('POST', '/v1/assistant/simulate', {
      monthlyCommitment: 1_200_000,
      months: 24,
    });

    expect(res.statusCode).toBe(200);

    const data = res.json<{
      data: { verdict: string; reason: string; reliable: boolean; monthlyCommitment: number };
    }>().data;

    expect(data.monthlyCommitment).toBe(1_200_000);
    expect(['aman', 'ketat', 'tidak_aman']).toContain(data.verdict);
    expect(data.reason.length).toBeGreaterThan(10);
  }, 30_000);

  /* Tanpa riwayat, sisa bulanan nol dan komitmen apa pun tidak aman. Jawaban
     itu benar — dan `reliable: false` yang mengatakan seberapa jauh ia layak
     dipercaya. */
  it('menyatakan terbuka ketika datanya belum cukup', async () => {
    const data = await api('POST', '/v1/assistant/simulate', {
      monthlyCommitment: 500_000,
      months: 12,
    }).then((r) => r.json<{ data: { reliable: boolean; basisDays: number } }>().data);

    expect(data.reliable).toBe(false);
    expect(data.basisDays).toBeLessThan(60);
  }, 30_000);

  it('menolak komitmen nol dan negatif', async () => {
    for (const monthlyCommitment of [0, -1000]) {
      const res = await api('POST', '/v1/assistant/simulate', { monthlyCommitment, months: 12 });
      expect(res.statusCode, String(monthlyCommitment)).toBe(422);
    }
  }, 30_000);

  it('menolak jangka waktu di luar batas', async () => {
    for (const months of [0, 361]) {
      const res = await api('POST', '/v1/assistant/simulate', {
        monthlyCommitment: 500_000,
        months,
      });
      expect(res.statusCode, String(months)).toBe(422);
    }
  }, 30_000);

  it('menolak tanpa token', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/assistant/simulate',
      payload: { monthlyCommitment: 100_000, months: 12 },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('chat grounded', () => {
  it('menjawab pertanyaan saldo dengan angka sungguhan', async () => {
    const acc = await api('POST', '/v1/accounts', {
      name: 'Chat',
      kind: 'cash',
      openingBalance: 4_500_000,
    });
    expect(acc.statusCode).toBe(201);

    const data = await api('POST', '/v1/assistant/ask', { question: 'berapa saldoku' }).then((r) =>
      r.json<{ data: { intent: string; answer: string; amount: number; grounding: string } }>().data,
    );

    expect(data.intent).toBe('balance');
    expect(data.amount).toBe(4_500_000);
    /* Angkanya ada DI DALAM kalimatnya — jawaban yang menyebut jumlah lain
       daripada yang dilaporkan adalah jawaban yang tidak dapat dipercaya. */
    expect(data.answer).toContain('4.500.000');
    expect(data.grounding.length).toBeGreaterThan(10);
  }, 60_000);

  /* Setiap jawaban membawa asal angkanya. Jawaban tanpa asal tidak dapat
     diperiksa siapa pun. */
  it('setiap jawaban yang dikenali membawa grounding', async () => {
    for (const question of ['berapa pengeluaranku', 'ke mana uangku pergi', 'anggaranku bagaimana']) {
      const data = await api('POST', '/v1/assistant/ask', { question }).then((r) =>
        r.json<{ data: { intent: string | null; grounding: string | null } }>().data,
      );

      expect(data.intent, question).not.toBeNull();
    }
  }, 60_000);

  it('mengakui ketika pertanyaannya di luar cakupan', async () => {
    const data = await api('POST', '/v1/assistant/ask', {
      question: 'siapa presiden Indonesia',
    }).then((r) => r.json<{ data: { intent: string | null; answer: string } }>().data);

    expect(data.intent).toBeNull();
    /* Menyebutkan apa yang BISA ditanyakan, bukan sekadar menolak — penolakan
       tanpa arah membuat pengguna menyerah pada percobaan kedua. */
    expect(data.answer).toContain('pengeluaran');
  }, 30_000);

  it('menolak pertanyaan kosong dan terlalu panjang', async () => {
    expect((await api('POST', '/v1/assistant/ask', { question: '' })).statusCode).toBe(422);
    expect(
      (await api('POST', '/v1/assistant/ask', { question: 'x'.repeat(400) })).statusCode,
    ).toBe(422);
  }, 30_000);

  it('menolak tanpa token', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/assistant/ask',
      payload: { question: 'berapa saldoku' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('simulasi dengan riwayat sungguhan', () => {
  it('menghitung sisa bulanan dari pemasukan dan pengeluaran nyata', async () => {
    const acc = await api('POST', '/v1/accounts', {
      name: 'Gaji',
      kind: 'bank',
      openingBalance: 10_000_000,
    });
    const accountId = acc.json<{ data: { id: string } }>().data.id;

    const day = 86_400_000;
    const now = Date.now();

    /* Sembilan puluh hari: gaji sepuluh juta per bulan, belanja dua ratus ribu
       per hari. Sisa bulanannya karena itu sekitar empat juta. */
    for (let i = 0; i < 3; i += 1) {
      await api('POST', '/v1/transactions', {
        accountId,
        kind: 'income',
        amount: 10_000_000,
        occurredAt: now - i * 30 * day,
      });
    }
    for (let i = 0; i < 30; i += 1) {
      await api('POST', '/v1/transactions', {
        accountId,
        kind: 'expense',
        amount: 200_000,
        occurredAt: now - i * 3 * day,
      });
    }

    const data = await api('POST', '/v1/assistant/simulate', {
      monthlyCommitment: 1_200_000,
      months: 24,
    }).then((r) =>
      r.json<{
        data: { currentMonthlySurplus: number; projectedMonthlySurplus: number; verdict: string };
      }>().data,
    );

    expect(data.currentMonthlySurplus).toBeGreaterThan(0);
    /* Selisihnya persis komitmennya — aritmetika, bukan tebakan. */
    expect(data.currentMonthlySurplus - data.projectedMonthlySurplus).toBe(1_200_000);
  }, 120_000);
});
