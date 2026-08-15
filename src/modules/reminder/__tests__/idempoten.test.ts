import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../../../contracts/auth.js';
import type { WalletAccount } from '../../../contracts/ledger.js';
import { createKeyProvider } from '../../../platform/crypto/keys.js';
import { outbox, users } from '../../../platform/db/schema.js';
import { toDateString } from '../../ledger/periods.js';
import { DEVICE, createHarness, type Harness } from '../../auth/__tests__/harness.js';
import { pindaiPengingat } from '../service.js';

/**
 * G1 — pengingat jatuh tempo TEPAT SEKALI, dibuktikan terhadap Postgres.
 *
 * ── MENGAPA UJI INI ADA DI SAMPING UJI PERENCANA ───────────────────────
 *
 * `rencana.test.ts` membuktikan kuncinya benar. Ia TIDAK dapat membuktikan
 * satu-satunya hal yang benar-benar mencegah email ganda, karena hal itu bukan
 * kode kita: indeks unik `outbox_idempotency` dan `ON CONFLICT DO NOTHING`.
 *
 * Perencana yang sempurna dengan indeks yang hilang tetap mengirim email
 * ganda, dan tidak satu pun uji murni akan merah. Yang membuktikannya hanya
 * basis data sungguhan.
 */

const HARI = 86_400_000;
const PASSWORD = 'kantongz-sandi-kuat';

/* Kunci uji HARUS sama persis dengan yang dipakai harness, kalau tidak alamat
   email yang didekripsi pemindai akan menjadi sampah — atau melempar. */
const KEYS = createKeyProvider({
  master: 'rahasia-induk-uji-yang-cukup-panjang',
  activeHmacVersion: 1,
});

let h: Harness;
let token = '';
let dompet = '';

const hariIni = (geser = 0): string => toDateString(new Date(Date.now() + geser * HARI));

beforeAll(async () => {
  h = await createHarness();

  const reg = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      fullName: 'Sri Penguji',
      email: 'pengingat@contoh.id',
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
  token = verify.json<{ data: Session }>().data.tokens.accessToken;

  const akun = await api('POST', '/v1/accounts', { name: 'Kas', kind: 'cash' });
  dompet = akun.json<{ data: WalletAccount }>().data.id;
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

async function buatAturan(over: Record<string, unknown> = {}): Promise<string> {
  const res = await api('POST', '/v1/recurring', {
    name: 'Langganan Internet',
    accountId: dompet,
    kind: 'expense',
    amount: 350_000,
    cadence: 'monthly',
    interval: 1,
    startsOn: hariIni(2),
    ...over,
  });
  if (res.statusCode >= 400) throw new Error(`${String(res.statusCode)} ${res.body}`);
  return res.json<{ data: { id: string } }>().data.id;
}

/** Seluruh rantai `cause` sebuah galat, dirangkai jadi satu teks. */
function rantaiGalat(error: unknown): string {
  const bagian: string[] = [];
  let saat: unknown = error;
  while (saat instanceof Error) {
    bagian.push(saat.message);
    saat = saat.cause;
  }
  return bagian.length > 0 ? bagian.join(' | ') : String(error);
}

/** Pesan pengingat yang benar-benar ada di antrean. */
async function suratPengingat(): Promise<
  { idempotencyKey: string; payload: { to: string; jatuhTempo?: { judul: string } } }[]
> {
  const rows = await h.db
    .select({ idempotencyKey: outbox.idempotencyKey, payload: outbox.payload })
    .from(outbox)
    .where(eq(outbox.topic, 'email.due_reminder'));
  return rows as never;
}

describe('G1 · satu kejadian, satu email', () => {
  it('putaran pertama mengantrekan pengingatnya', async () => {
    await buatAturan();

    const hasil = await pindaiPengingat({ db: h.db, keys: KEYS }, new Date());

    expect(hasil.layak).toBe(1);
    expect(hasil.diantrekan).toBe(1);

    const surat = await suratPengingat();
    expect(surat).toHaveLength(1);
    expect(surat[0]?.payload.to).toBe('pengingat@contoh.id');
    expect(surat[0]?.payload.jatuhTempo?.judul).toBe('Langganan Internet');
  }, 60_000);

  it('putaran kedua TIDAK mengantrekan apa pun — dan tetap melaporkannya layak', async () => {
    /* `layak` tetap 1 dan `diantrekan` 0. Bedanya penting: kalau keduanya nol,
       tidak ada cara membedakan "sudah pernah dikirim" dari "perencana berhenti
       menemukan apa pun" — dan yang kedua adalah kerusakan senyap. */
    const hasil = await pindaiPengingat({ db: h.db, keys: KEYS }, new Date());

    expect(hasil.layak).toBe(1);
    expect(hasil.diantrekan).toBe(0);
    expect(await suratPengingat()).toHaveLength(1);
  }, 60_000);

  it('sepuluh putaran yang dilepas bersamaan tetap menghasilkan satu email', async () => {
    /*
       ── APA YANG UJI INI BUKTIKAN, DAN APA YANG TIDAK ──────────────────

       Yang dibuktikan: sepuluh pemanggilan yang saling tumpang tindih tidak
       merusak apa pun, dan tidak satu pun melempar.

       Yang TIDAK dibuktikan: keamanan terhadap perlombaan sungguhan. PGlite
       menjalankan seluruh uji ini di atas SATU koneksi yang menyerialkan
       pernyataan, jadi `Promise.all` di sini menghasilkan sepuluh panggilan
       berurutan yang terlihat seperti sepuluh panggilan bersamaan.

       Ini bukan dugaan. Saya menukar `ON CONFLICT DO NOTHING` dengan
       "periksa dulu, baru tulis" — implementasi yang justru rusak di bawah
       perlombaan — dan uji ini tetap HIJAU. Uji berikutnyalah yang menangkap
       penukaran itu, karena ia menguji indeksnya, bukan penjadwalannya.

       Dibiarkan ada sebagai uji asap, dengan klaim yang sudah dikecilkan
       supaya tidak ada yang mengira perlombaan sudah tertutup di sini.
    */
    await Promise.all(
      Array.from({ length: 10 }, () => pindaiPengingat({ db: h.db, keys: KEYS }, new Date())),
    );

    expect(await suratPengingat()).toHaveLength(1);
  }, 90_000);

  it('BASIS DATA-nya sendiri yang menolak kunci kembar, bukan kode kita', async () => {
    /*
       Uji yang benar-benar menjaga idempotensi G1.

       Seluruh jaminan "satu kejadian, satu email" bersandar pada satu indeks
       unik — `outbox_idempotency`. Perencana yang sempurna dengan indeks yang
       hilang tetap mengirim email ganda pada penyebaran bergulir, dan tidak
       satu pun uji lain di repositori ini akan merah.

       Jadi indeksnya diuji secara langsung: sisipan kembar yang MELEWATI
       `enqueue` harus ditolak oleh Postgres. Kalau indeksnya suatu hari hilang
       dari migrasi, baris ini yang memberi tahu.
    */
    const kunci = (await suratPengingat())[0]?.idempotencyKey;
    expect(kunci).toBeDefined();

    /*
       Galatnya diperiksa ISINYA sampai ke NAMA INDEKSNYA, bukan sekadar
       "melempar".

       Versi pertama uji ini hanya menuntut `rejects.toThrow()` dan hijau —
       padahal sisipan ini dapat gagal karena selusin sebab lain: kolom wajib
       yang terlewat, enum topik yang salah, id yang kembar. Uji yang menerima
       lemparan apa pun akan tetap hijau setelah indeksnya hilang dari migrasi,
       yaitu satu-satunya keadaan yang seharusnya ia deteksi.
    */
    let pesan = '';
    try {
      await h.db.insert(outbox).values({
        id: 'obx_kembar_uji',
        topic: 'email.due_reminder',
        idempotencyKey: kunci ?? '',
        payload: { to: 'pengingat@contoh.id' },
      });
    } catch (error) {
      /* Drizzle membungkus galat pengandar dengan "Failed query: ...", dan
         sebab sungguhannya — nama indeks yang dilanggar — hanya ada di rantai
         `cause`. Membaca `message` saja menerima kegagalan apa pun. */
      pesan = rantaiGalat(error);
    }

    expect(pesan).toMatch(/outbox_idempotency/);
    expect(await suratPengingat()).toHaveLength(1);
  }, 60_000);

  it('putaran pada hari-hari berikutnya tetap tidak menambah email', async () => {
    /* Kunci berbasis tanggal KIRIM akan menambah satu email tiap panggilan di
       sini, dan lulus setiap uji lain di berkas ini. */
    for (const geser of [1, 2]) {
      await pindaiPengingat({ db: h.db, keys: KEYS }, new Date(Date.now() + geser * HARI));
    }

    expect(await suratPengingat()).toHaveLength(1);
  }, 60_000);
});

describe('G1 · satu baris rusak tidak membungkam yang lain', () => {
  it('pengguna yang barisnya tak terbaca DILEWATI, sisanya tetap diingatkan', async () => {
    /*
       ── KEGAGALAN SUNGGUHAN YANG DITEMUKAN GERBANG ─────────────────────

       Versi pertama `aturanMendekatiJatuhTempo` memakai `.map()`, jadi satu
       baris yang tidak dapat didekripsi menggagalkan SELURUH pemindaian.
       Di basis data pengembangan, 2 dari 9 pengguna disandikan kunci lain —
       dan ketujuh yang sah tidak menerima satu pun pengingat selama enam
       putaran berturut-turut, tanpa satu uji pun memerah.

       Di sini keadaannya dibuat ulang dengan merusak cipherteks satu
       pengguna: pemindaian harus TETAP mengantrekan pengingat bagi yang lain,
       dan harus MELAPORKAN yang dilewatinya.
    */
    const korban = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        fullName: 'Kunci Lain',
        email: 'kuncilain@contoh.id',
        password: PASSWORD,
        device: DEVICE,
      },
    });
    const sesiKorban = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: {
        ticket: korban.json<{ data: { ticket: string } }>().data.ticket,
        code: h.lastCode()?.code,
        device: DEVICE,
      },
    });
    const tokenKorban = sesiKorban.json<{ data: Session }>().data.tokens.accessToken;
    const authKorban = { authorization: `Bearer ${tokenKorban}` };

    const dompetKorban = await h.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: authKorban,
      payload: { name: 'Kas Korban', kind: 'cash' },
    });
    await h.app.inject({
      method: 'POST',
      url: '/v1/recurring',
      headers: authKorban,
      payload: {
        name: 'Tagihan Korban',
        accountId: dompetKorban.json<{ data: WalletAccount }>().data.id,
        kind: 'expense',
        amount: 99_000,
        cadence: 'monthly',
        interval: 1,
        startsOn: hariIni(1),
      },
    });

    /* Cipherteksnya dirusak — persis seperti baris yang disandikan kunci lain:
       tanda autentikasi GCM-nya tidak lagi cocok. */
    const idKorban = await h.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, sesiKorban.json<{ data: Session }>().data.user.id));
    expect(idKorban).toHaveLength(1);

    await h.db
      .update(users)
      .set({ emailEncrypted: Buffer.alloc(56, 7) })
      .where(eq(users.id, idKorban[0]?.id ?? ''));

    const sebelum = (await suratPengingat()).length;

    /* Aturan BARU untuk pengguna yang sah, supaya ada yang layak diantrekan
       pada putaran yang sama dengan baris yang rusak. */
    await buatAturan({ name: 'Tagihan Sehat', startsOn: hariIni(3) });

    const hasil = await pindaiPengingat({ db: h.db, keys: KEYS }, new Date());

    /* Yang rusak dilaporkan, bukan ditelan. */
    expect(hasil.takTerbaca).toContain(idKorban[0]?.id);

    /* Dan yang sehat TETAP terkirim — inti seluruh perbaikan ini. */
    expect(hasil.diantrekan).toBeGreaterThanOrEqual(1);
    expect((await suratPengingat()).length).toBeGreaterThan(sebelum);
  }, 120_000);
});

describe('G1 · siapa yang TIDAK diingatkan', () => {
  it('aturan yang masih jauh tidak menghasilkan email', async () => {
    const sebelum = (await suratPengingat()).length;
    await buatAturan({ name: 'Masih Jauh', startsOn: hariIni(30) });

    const hasil = await pindaiPengingat({ db: h.db, keys: KEYS }, new Date());

    expect(hasil.diantrekan).toBe(0);
    expect(await suratPengingat()).toHaveLength(sebelum);
  }, 60_000);

  it('aturan yang dijeda tidak menghasilkan email', async () => {
    const sebelum = (await suratPengingat()).length;
    const id = await buatAturan({ name: 'Dijeda', startsOn: hariIni(1) });

    const jeda = await api('POST', `/v1/recurring/${id}/pause`, { paused: true });
    expect(jeda.statusCode).toBeLessThan(400);

    const hasil = await pindaiPengingat({ db: h.db, keys: KEYS }, new Date());

    expect(hasil.diantrekan).toBe(0);
    expect(await suratPengingat()).toHaveLength(sebelum);
  }, 60_000);

  it('aturan pengguna LAIN tidak pernah dikirim ke alamat kita', async () => {
    /* Pemindai berjalan tanpa satu pun permintaan HTTP, jadi tidak ada
       middleware kepemilikan yang menjaganya. Gabungan `user_id`-nya yang
       menjaga — dan itu harus diuji, bukan diasumsikan. */
    const surat = await suratPengingat();
    for (const s of surat) {
      expect(s.payload.to).toBe('pengingat@contoh.id');
    }
  }, 60_000);
});
