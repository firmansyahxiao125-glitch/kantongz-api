import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../../audit/index.js';
import { DEVICE, createHarness, type Harness } from './harness.js';

/**
 * Uji konkurensi.
 *
 * Yang diuji di sini tidak dapat dibuktikan uji berurutan mana pun: apa yang
 * terjadi ketika beberapa permintaan menyentuh keadaan yang sama pada saat yang
 * sama. Balapan tidak muncul saat permintaan datang satu per satu, dan justru
 * itulah sebabnya balapan lolos ke produksi.
 *
 * Ini bukan uji beban. Yang diukur bukan berapa permintaan per detik melainkan
 * apakah jawabannya tetap BENAR ketika permintaan saling tumpang tindih.
 */

let h: Harness;

const PASSWORD = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

function post(url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: 'POST', url, payload });
}

async function newSession(email: string) {
  const reg = await post('/v1/auth/register', {
    fullName: 'Konkurensi',
    email,
    password: PASSWORD,
    device: DEVICE,
  });

  const ticket = reg.json<{ data: { ticket: string } }>().data.ticket;
  const verify = await post('/v1/auth/verify', {
    ticket,
    code: h.lastCode()?.code,
    device: DEVICE,
  });

  return verify.json<{ data: { tokens: { refreshToken: string; accessToken: string } } }>().data
    .tokens;
}

describe('rotasi berbarengan', () => {
  /**
   * Sepuluh permintaan refresh dengan token yang SAMA, berangkat bersamaan.
   *
   * Inilah keadaan yang benar-benar terjadi di aplikasi: sepuluh kueri
   * TanStack Query menemui token kedaluwarsa pada frame yang sama. Aplikasi
   * menggabungkannya (single-flight), tetapi backend tidak boleh bergantung
   * pada klien yang berperilaku baik.
   *
   * Yang harus benar: TIDAK ADA yang mendapat generasi berbeda-beda. Entah
   * seluruhnya mendapat hasil yang sama dari jendela grace (§5.3), atau
   * sebagian ditolak — yang tidak boleh adalah sepuluh keluarga token yang
   * berlainan hidup bersamaan dari satu induk.
   */
  it('sepuluh refresh serentak tidak menerbitkan sepuluh generasi berbeda', async () => {
    const tokens = await newSession('konkuren-rotasi@contoh.id');

    const hasil = await Promise.all(
      Array.from({ length: 10 }, () =>
        post('/v1/auth/refresh', { refreshToken: tokens.refreshToken, device: DEVICE }),
      ),
    );

    const sukses = hasil.filter((r) => r.statusCode === 200);
    const diterbitkan = new Set(
      sukses.map((r) => r.json<{ data: { refreshToken: string } }>().data.refreshToken),
    );

    expect(sukses.length).toBeGreaterThan(0);
    /* Satu token untuk semua yang berhasil. Lebih dari satu berarti dua
       keluarga hidup dari satu induk, dan salah satunya akan dicabut nanti
       tanpa pemiliknya pernah melakukan kesalahan. */
    expect(diterbitkan.size).toBe(1);

    /* Dan yang diterbitkan itu benar-benar dapat dipakai sesudahnya. */
    const lanjut = await post('/v1/auth/refresh', {
      refreshToken: [...diterbitkan][0],
      device: DEVICE,
    });
    expect(lanjut.statusCode).toBe(200);
  }, 120_000);
});

describe('penguncian berbarengan', () => {
  /**
   * Dua puluh percobaan gagal serentak pada satu alamat.
   *
   * Penghitung yang dibaca lalu ditulis di aplikasi akan kehilangan sebagian
   * hitungan di bawah paralelisme, dan penguncian yang bisa dilewati dengan
   * mengirim permintaan bersamaan bukan penguncian sama sekali.
   */
  it('mengunci meski seluruh percobaan berangkat bersamaan', async () => {
    const email = 'konkuren-kunci@contoh.id';
    await newSession(email);

    const hasil = await Promise.all(
      Array.from({ length: 20 }, () =>
        post('/v1/auth/sign-in', { email, password: 'salah-terus', device: DEVICE }),
      ),
    );

    expect(hasil.some((r) => r.statusCode === 429)).toBe(true);

    /* Dan sesudah badai selesai, sandi BENAR tetap ditolak. */
    const benar = await post('/v1/auth/sign-in', { email, password: PASSWORD, device: DEVICE });
    expect(benar.statusCode).toBe(429);
  }, 120_000);
});

describe('pendaftaran berbarengan', () => {
  /**
   * Lima pendaftaran serentak dengan alamat yang sama.
   *
   * Pemeriksaan "apakah email sudah ada" lalu "sisipkan" adalah dua langkah,
   * dan lima permintaan bersamaan semuanya lolos langkah pertama. Yang
   * menegakkan keunikan adalah indeks unik parsial `users_email_active`, bukan
   * pemeriksaannya — dan uji ini yang membuktikan indeks itu benar-benar
   * menahan.
   */
  it('hanya satu akun terbuat untuk satu alamat', async () => {
    const email = 'konkuren-daftar@contoh.id';

    const hasil = await Promise.all(
      Array.from({ length: 5 }, () =>
        post('/v1/auth/register', {
          fullName: 'Balapan',
          email,
          password: PASSWORD,
          device: DEVICE,
        }),
      ),
    );

    const dibuat = hasil.filter((r) => r.statusCode === 201);
    const ditolak = hasil.filter((r) => r.statusCode !== 201);

    expect(dibuat.length).toBe(1);
    expect(ditolak.length).toBe(4);

    /* Yang ditolak TIDAK boleh 500. Pelanggaran indeks unik yang bocor sebagai
       galat server memberi tahu penyerang bahwa ia menang balapan, dan
       menampilkan jejak tumpukan basis data kepada siapa pun. */
    for (const r of ditolak) {
      expect(r.statusCode, r.body).toBeLessThan(500);
    }
  }, 120_000);
});

describe('tujuan berbarengan', () => {
  /**
   * Kontribusi tujuan menaikkan `saved_amount`.
   *
   * Baca-lalu-tulis di aplikasi akan kehilangan penambahan di bawah
   * paralelisme — sepuluh kontribusi seratus ribu bisa berakhir sebagai satu
   * juta atau sebagai dua ratus ribu, dan yang kedua terjadi diam-diam.
   * Penambahannya dikerjakan basis data (`saved_amount + $1`), dan uji ini yang
   * membuktikannya.
   */
  it('sepuluh kontribusi serentak dijumlahkan seluruhnya', async () => {
    const tokens = await newSession('konkuren-tujuan@contoh.id');
    const auth = { authorization: `Bearer ${tokens.accessToken}` };

    const goal = await h.app.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: auth,
      payload: { name: 'Balapan Menabung', targetAmount: 10_000_000 },
    });
    const id = goal.json<{ data: { id: string } }>().data.id;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        h.app.inject({
          method: 'POST',
          url: `/v1/goals/${id}/contribute`,
          headers: auth,
          payload: { amount: 100_000 },
        }),
      ),
    );

    const daftar = await h.app.inject({ method: 'GET', url: '/v1/goals', headers: auth });
    const tujuan = daftar
      .json<{ data: { id: string; savedAmount: number }[] }>()
      .data.find((g) => g.id === id);

    expect(tujuan?.savedAmount).toBe(1_000_000);
  }, 120_000);
});

describe('transaksi berbarengan', () => {
  /** Saldo dihitung dari buku, jadi tidak ada kolom yang bisa hilang
   *  penambahannya — uji ini yang membuktikan klaim itu di bawah paralelisme. */
  it('dua puluh transaksi serentak seluruhnya tercermin di saldo', async () => {
    const tokens = await newSession('konkuren-transaksi@contoh.id');
    const auth = { authorization: `Bearer ${tokens.accessToken}` };

    const acc = await h.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: auth,
      payload: { name: 'Kas Balapan', kind: 'cash', openingBalance: 5_000_000 },
    });
    const accountId = acc.json<{ data: { id: string } }>().data.id;

    const hasil = await Promise.all(
      Array.from({ length: 20 }, () =>
        h.app.inject({
          method: 'POST',
          url: '/v1/transactions',
          headers: auth,
          payload: {
            accountId,
            kind: 'expense',
            amount: 50_000,
            occurredAt: Date.now(),
          },
        }),
      ),
    );

    expect(hasil.every((r) => r.statusCode === 201)).toBe(true);

    const list = await h.app.inject({ method: 'GET', url: '/v1/accounts', headers: auth });
    const saldo = list
      .json<{ data: { id: string; balance: number }[] }>()
      .data.find((a) => a.id === accountId)?.balance;

    expect(saldo).toBe(5_000_000 - 20 * 50_000);
  }, 120_000);
});

describe('jejak audit di bawah konkurensi', () => {
  /**
   * Rantai audit adalah `SHA256(prevHash ‖ isi)`, dan dua penulisan bersamaan
   * dapat membaca `prevHash` yang sama lalu bercabang.
   *
   * Uji ini yang menyatakan apakah rantainya menahan setelah seluruh badai di
   * atas. Kalau tidak, itu temuan nyata dan harus terlihat — bukan tersembunyi
   * di balik uji yang hanya menulis satu baris pada satu waktu.
   */
  it('rantai tetap utuh setelah seluruh uji konkurensi di atas', async () => {
    const hasil = await verifyAuditChain(h.db);

    expect(hasil.checked).toBeGreaterThan(0);
    expect(hasil.intact, `rantai putus di baris ${hasil.brokenAtId ?? '?'}`).toBe(true);
  }, 60_000);
});
