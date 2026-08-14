import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { outbox } from '../../../platform/db/schema.js';
import { createHarness, type Harness } from './harness.js';

/**
 * Peringatan masuk dari perangkat baru.
 *
 * ── APA YANG SEBENARNYA DIJAGA ──────────────────────────────────────────
 *
 * Bukan "email terkirim" — itu bagian yang mudah. Yang sulit, dan yang
 * menentukan apakah fitur ini berguna atau justru merusak, adalah KAPAN ia
 * TIDAK berbunyi:
 *
 *   pendaftaran        perangkatnya selalu baru. Memberi peringatan di sini
 *                      berarti memperingatkan pengguna tentang tindakan yang
 *                      baru saja ia lakukan sendiri.
 *   perangkat dikenal  masuk kedua dari perangkat yang sama bukan kejadian.
 *   masuk berulang     satu perangkat baru = TEPAT satu peringatan, selamanya.
 *
 * Peringatan yang berbunyi pada kejadian normal adalah peringatan yang
 * diabaikan pada kejadian yang sesungguhnya — dan pengguna yang sudah terbiasa
 * mengabaikannya tidak akan membaca yang satu itu.
 */

let h: Harness;

const SANDI = 'kantongz-sandi-kuat';

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

const device = (n: string) => ({ deviceId: `perangkat-${n}`, platform: 'web' as const, model: 'Chrome' });

async function daftar(email: string, dev: ReturnType<typeof device>) {
  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { fullName: 'Uji Perangkat', email, password: SANDI, device: dev },
  });
  const ticket = reg.json<{ data: { ticket: string } }>().data.ticket;
  await h.app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { ticket, code: h.lastCode()?.code, device: dev },
  });
}

async function masuk(email: string, dev: ReturnType<typeof device>) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email, password: SANDI, device: dev },
  });
}

/** Berapa peringatan perangkat baru yang diantrekan untuk alamat ini. */
async function peringatan(email: string): Promise<number> {
  const rows = await h.db
    .select({ topic: outbox.topic, payload: outbox.payload })
    .from(outbox)
    .where(eq(outbox.topic, 'email.new_device'));

  return rows.filter((r) => (r.payload as { to?: string }).to === email).length;
}

describe('peringatan perangkat baru', () => {
  it('TIDAK dikirim saat pendaftaran', async () => {
    const email = 'perangkat-daftar@contoh.id';
    await daftar(email, device('daftar-1'));

    /* Perangkat pendaftaran selalu baru. Kalau baris ini pernah menjadi 1,
       setiap pengguna baru menerima peringatan keamanan tentang dirinya
       sendiri satu detik sesudah mendaftar. */
    expect(await peringatan(email)).toBe(0);
  }, 40_000);

  it('dikirim saat masuk dari perangkat yang BELUM pernah dipakai', async () => {
    const email = 'perangkat-baru@contoh.id';
    await daftar(email, device('baru-1'));
    expect(await peringatan(email)).toBe(0);

    const res = await masuk(email, device('baru-2'));
    expect(res.statusCode).toBe(200);
    expect(await peringatan(email)).toBe(1);
  }, 40_000);

  it('TIDAK dikirim saat masuk dari perangkat yang sudah dikenal', async () => {
    const email = 'perangkat-dikenal@contoh.id';
    const dev = device('dikenal-1');
    await daftar(email, dev);

    expect((await masuk(email, dev)).statusCode).toBe(200);
    expect(await peringatan(email)).toBe(0);
  }, 40_000);

  it('satu perangkat baru menghasilkan TEPAT satu peringatan, berapa kali pun masuk', async () => {
    const email = 'perangkat-sekali@contoh.id';
    await daftar(email, device('sekali-1'));

    const lain = device('sekali-2');
    await masuk(email, lain);
    await masuk(email, lain);
    await masuk(email, lain);

    /* Kunci idempotensi memuat id perangkat, bukan waktu. Tanpa itu, setiap
       masuk dari perangkat yang sama mengirim satu email lagi — dan pengguna
       yang menerima peringatan tiap hari berhenti membacanya. */
    expect(await peringatan(email)).toBe(1);
  }, 40_000);

  it('memuat label perangkat, dan BUKAN User-Agent mentah', async () => {
    const email = 'perangkat-label@contoh.id';
    await daftar(email, device('label-1'));
    await masuk(email, device('label-2'));

    const rows = await h.db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(eq(outbox.topic, 'email.new_device'));

    const milikku = rows
      .map((r) => r.payload as { to?: string; device?: string })
      .find((p) => p.to === email);

    expect(milikku?.device).toBe('web · Chrome');
    /* Email peringatan yang memuat satu paragraf teknis berhenti dibaca. */
    expect(milikku?.device).not.toMatch(/Mozilla|AppleWebKit/);
  }, 40_000);
});
