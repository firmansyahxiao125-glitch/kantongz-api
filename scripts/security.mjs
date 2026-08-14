#!/usr/bin/env node
/**
 * Gerbang KEAMANAN terhadap API yang berjalan.
 *
 * ── APA YANG DIJAGA ────────────────────────────────────────────────────
 *
 * Empat kelas serangan yang tidak dapat dibuktikan uji unit, karena
 * seluruhnya tentang bagaimana peladen SUNGGUHAN memperlakukan permintaan
 * yang datang dari pihak yang salah:
 *
 *   IDOR/BOLA   pengguna B menyentuh sumber daya milik pengguna A
 *   Sesi        token yang sudah dicabut masih diterima
 *   CORS        asal jahat mendapat izin memanggil API dengan kredensial
 *   Kebocoran   respons memuat hash sandi, nama tabel, atau SQL
 *
 * Uji unit menegakkan aturan di dalam satu proses; berkas ini menegakkannya
 * di batas HTTP, tempat penyerang sebenarnya berdiri.
 *
 * ── MENGAPA IA MENANAM AKUNNYA SENDIRI ─────────────────────────────────
 *
 * Versi pertama skrip ini masuk memakai dua alamat yang kebetulan ada di
 * basis data pengembangan satu mesin. Skrip semacam itu bukan gerbang: ia
 * hijau di laptop yang tepat dan gagal di mana pun selain itu — termasuk pada
 * clone baru dan di CI, yaitu justru tempat gerbang paling dibutuhkan.
 *
 * Di sini kedua pengguna DIBUAT lewat API yang sama dengan pengguna sungguhan,
 * termasuk argon2id dan verifikasi email. Tidak ada baris yang disuntik
 * langsung ke basis data: jalur yang dilewati adalah jalur yang tidak diuji.
 *
 * Kode verifikasi diambil dari Mailpit atau dari log peladen — pola yang sama
 * dengan `loadtest.mjs`, karena langkah manual di tengah gerbang berarti
 * gerbang itu tidak akan dijalankan dua kali.
 *
 * Jalankan:
 *   docker compose up -d
 *   node scripts/security.mjs --mailpit http://localhost:8025
 */

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const BASE = arg('base', 'http://localhost:3000');
const MAILPIT = arg('mailpit', null);
const LOGFILE = arg('logfile', null);
/* Asal yang HARUS diizinkan. Wajib ada di CORS_ORIGINS peladen yang diuji. */
const ASAL_SAH = arg('origin', 'http://localhost:3100');
const SANDI = 'KataSandi#2026';

let lulus = 0;
let gagal = 0;

function ok(nama, syarat, extra = '') {
  if (syarat) {
    lulus += 1;
    console.log(`  OK    ${nama} ${extra}`);
  } else {
    gagal += 1;
    console.log(`  GAGAL ${nama} ${extra}`);
  }
}

const J = async (r) => ({ s: r.status, b: await r.json().catch(() => ({})) });
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

const device = (n) => ({ deviceId: `sec-probe-${n}-0001`, platform: 'web' });

/** Kode verifikasi, dari Mailpit atau dari log. Sama seperti `loadtest.mjs`. */
async function kodeUntuk(email) {
  if (MAILPIT) {
    for (let i = 0; i < 60; i += 1) {
      const box = await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json();
      /* Mailpit mengurutkan TERBARU DULU — cari berdasarkan alamat. */
      for (const m of box.messages ?? []) {
        const to = (m.To ?? []).map((a) => a.Address).join(' ');
        if (!to.includes(email)) continue;
        const full = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
        const hit = /\b\d{6}\b/.exec(`${full.Text ?? ''}${full.HTML ?? ''}`);
        if (hit) return hit[0];
      }
      await sleep(400);
    }
  }
  if (LOGFILE) {
    for (let i = 0; i < 40; i += 1) {
      const log = readFileSync(LOGFILE, 'utf8');
      const hits = [...log.matchAll(/VERIFY\s+(\S+)\s+→ kode (\d{4,8})/g)];
      const mine = hits.filter(([, to]) => to === email).at(-1);
      if (mine) return mine[2];
      await sleep(300);
    }
  }
  throw new Error(
    'kode verifikasi tidak tersedia. Beri --mailpit http://localhost:8025 (susunan compose) ' +
      'atau --logfile server.log (mode standalone).',
  );
}

/** Satu pengguna baru, dibuat lewat jalur yang sama dengan pengguna sungguhan. */
async function tanamPengguna(label) {
  const email = `sec-${label}-${String(Date.now())}@contoh.id`;
  const reg = await J(
    await fetch(`${BASE}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: `Uji Keamanan ${label}`, email, password: SANDI, device: device(label) }),
    }),
  );
  if (reg.s !== 201) throw new Error(`pendaftaran ${label} gagal: ${String(reg.s)}`);

  const ver = await J(
    await fetch(`${BASE}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: reg.b.data.ticket, code: await kodeUntuk(email), device: device(label) }),
    }),
  );
  if (ver.s !== 200) throw new Error(`verifikasi ${label} gagal: ${String(ver.s)}`);
  return { email, tokens: ver.b.data.tokens };
}

/* ── penyiapan ────────────────────────────────────────────────────────── */

console.log(`Gerbang keamanan → ${BASE}\n`);

const A = await tanamPengguna('a');
const B = await tanamPengguna('b');

const post = async (path, token, body) =>
  J(await fetch(`${BASE}${path}`, { method: 'POST', headers: H(token), body: JSON.stringify(body) }));

/* A diberi data supaya ada sesuatu yang bisa dicuri; B sengaja kosong. */
const akun = await post('/v1/accounts', A.tokens.accessToken, {
  name: 'Dompet A', kind: 'cash', openingBalance: 5_000_000,
});
const kategori = (
  await (await fetch(`${BASE}/v1/categories`, { headers: H(A.tokens.accessToken) })).json()
).data.find((c) => c.kind === 'expense');

const trx = await post('/v1/transactions', A.tokens.accessToken, {
  accountId: akun.b.data.id, kind: 'expense', amount: 50_000,
  categoryId: kategori.id, occurredAt: Date.now(), merchant: 'Warung A',
});
const anggaran = await post('/v1/budgets', A.tokens.accessToken, {
  categoryId: kategori.id, amount: 1_000_000, period: 'monthly',
});

const tokA = A.tokens.accessToken;
const tokB = B.tokens.accessToken;
let r;

/* ── IDOR / BOLA ──────────────────────────────────────────────────────── */

console.log('--- IDOR / BOLA: B mencoba menyentuh milik A ---');

/* 404 maupun 403 sama-sama benar. Yang TIDAK boleh adalah 200 — dan juga
   tidak boleh 500, sebab galat tak tertangani sering membocorkan bentuk data. */
const ditolak = (s) => s === 404 || s === 403;

r = await J(await fetch(`${BASE}/v1/accounts/${akun.b.data.id}`, {
  method: 'PATCH', headers: H(tokB), body: JSON.stringify({ name: 'DIBAJAK' }),
}));
ok('B tidak bisa mengubah dompet A', ditolak(r.s), `(${String(r.s)})`);

r = await J(await fetch(`${BASE}/v1/transactions/${trx.b.data.id}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${tokB}` },
}));
ok('B tidak bisa menghapus transaksi A', ditolak(r.s), `(${String(r.s)})`);

r = await J(await fetch(`${BASE}/v1/transactions/${trx.b.data.id}`, {
  method: 'PUT', headers: H(tokB),
  body: JSON.stringify({ accountId: akun.b.data.id, kind: 'expense', amount: 1, occurredAt: Date.now() }),
}));
ok('B tidak bisa mengubah transaksi A', ditolak(r.s), `(${String(r.s)})`);

r = await J(await fetch(`${BASE}/v1/budgets/${anggaran.b.data.id}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${tokB}` },
}));
ok('B tidak bisa menutup anggaran A', ditolak(r.s), `(${String(r.s)})`);

r = await J(await fetch(`${BASE}/v1/transactions`, {
  method: 'POST', headers: H(tokB),
  body: JSON.stringify({ accountId: akun.b.data.id, kind: 'expense', amount: 1000, occurredAt: Date.now() }),
}));
ok('B tidak bisa menulis ke dompet A', ditolak(r.s), `(${String(r.s)})`);

const dashB = (await (await fetch(`${BASE}/v1/dashboard`, { headers: H(tokB) })).json()).data;
ok('dasbor B tidak memuat dompet A', !dashB.accounts.some((a) => a.id === akun.b.data.id));
ok('dasbor B tidak memuat transaksi A', !dashB.recent.some((t) => t.id === trx.b.data.id));

/* ── sesi ─────────────────────────────────────────────────────────────── */

console.log('\n--- Sesi ---');

r = await J(await fetch(`${BASE}/v1/auth/sign-out`, {
  method: 'POST', headers: H(tokB), body: JSON.stringify({ refreshToken: B.tokens.refreshToken }),
}));
ok('sign-out 200', r.s === 200, `(${String(r.s)})`);

r = await J(await fetch(`${BASE}/v1/auth/refresh`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ refreshToken: B.tokens.refreshToken, device: device('b') }),
}));
ok('refresh token bekas ditolak', r.s >= 400, `(${String(r.s)})`);

/* ── CORS ─────────────────────────────────────────────────────────────── */

console.log('\n--- CORS ---');

/* Preflight, bukan permintaan biasa: di sinilah peramban memutuskan boleh
   atau tidak, dan di sinilah daftar izin benar-benar ditegakkan. */
const cors = async (origin) => {
  const x = await fetch(`${BASE}/v1/dashboard`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  return x.headers.get('access-control-allow-origin');
};

ok('asal sah diizinkan', (await cors(ASAL_SAH)) === ASAL_SAH, `(${ASAL_SAH})`);
const jahat = await cors('https://penyerang.example');
ok('asal jahat TIDAK diizinkan', jahat === null, `(${String(jahat)})`);

/* ── kebocoran data ───────────────────────────────────────────────────── */

console.log('\n--- Kebocoran data ---');

const me = await (await fetch(`${BASE}/v1/auth/me`, { headers: H(tokA) })).json();
ok('/auth/me tanpa hash sandi', !/password|hash|argon|\$2[aby]\$/i.test(JSON.stringify(me)));

r = await J(await fetch(`${BASE}/v1/accounts`, {
  method: 'POST', headers: H(tokA), body: JSON.stringify({ name: 'x'.repeat(500), kind: 'cash' }),
}));
ok('masukan berlebihan ditolak', r.s >= 400 && r.s < 500, `(${String(r.s)})`);
ok(
  'pesan galat tidak membocorkan SQL/tabel',
  !/wallet_accounts|insert into|drizzle|postgres/i.test(JSON.stringify(r.b)),
);

/* ── aturan berulang: kepemilikan dan penulisan ganda ─────────────────── */

console.log('\n--- Aturan berulang ---');

const hariIni = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const penanda = `sec-berulang-${String(Date.now())}`;

const aturanA = await post('/v1/recurring', tokA, {
  name: 'Langganan A', accountId: akun.b.data.id, categoryId: kategori.id,
  kind: 'expense', amount: 33_000, cadence: 'daily', interval: 1,
  startsOn: hariIni, merchant: penanda,
});
ok('A dapat membuat aturan berulang', aturanA.s === 201, `(${String(aturanA.s)})`);

r = await J(await fetch(`${BASE}/v1/recurring`, { headers: H(tokB) }));
ok('B tidak melihat aturan A', !JSON.stringify(r.b).includes(aturanA.b.data?.id ?? ' '));

r = await J(await fetch(`${BASE}/v1/recurring/${aturanA.b.data.id}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${tokB}` },
}));
ok('B tidak bisa menghapus aturan A', ditolak(r.s), `(${String(r.s)})`);

r = await post('/v1/recurring', tokB, {
  name: 'Nyelinap', accountId: akun.b.data.id, kind: 'expense',
  amount: 1_000, cadence: 'daily', interval: 1, startsOn: hariIni,
});
ok('B tidak bisa menjadwalkan ke dompet A', ditolak(r.s), `(${String(r.s)})`);

/*
 * TIGA PUTARAN SERENTAK, TERHADAP POSTGRESQL SUNGGUHAN.
 *
 * Inilah yang tidak dapat dibuktikan uji unit: harness memakai PGlite dengan
 * satu koneksi, jadi `Promise.all` di sana hanya menyerialkan pernyataannya.
 * Di sini ketiganya benar-benar berebut baris yang sama lewat tiga koneksi
 * HTTP, dan yang menjaganya adalah `FOR UPDATE SKIP LOCKED` ditambah indeks
 * unik `(rule_id, occurred_on)`.
 *
 * Tagihan yang tercatat dua kali baru ketahuan saat saldo tidak lagi cocok,
 * berbulan-bulan kemudian, dan saat itu tidak ada yang tahu harus mencari
 * di mana.
 */
await Promise.all([
  post('/v1/recurring/run', tokA, {}),
  post('/v1/recurring/run', tokA, {}),
  post('/v1/recurring/run', tokA, {}),
]);

const daftar = await (
  await fetch(`${BASE}/v1/transactions?limit=100`, { headers: H(tokA) })
).json();
const lahir = (daftar.data?.items ?? []).filter((t) => t.merchant === penanda);
ok('tiga putaran serentak menulis TEPAT SATU', lahir.length === 1, `(${String(lahir.length)})`);

const sesudah = await (await fetch(`${BASE}/v1/recurring`, { headers: H(tokA) })).json();
const punyaA = (sesudah.data ?? []).find((x) => x.id === aturanA.b.data.id);
ok('tanggal jalan maju sesudah dicatat', (punyaA?.nextRunOn ?? '') > hariIni, `(${String(punyaA?.nextRunOn)})`);
ok('jumlah yang dilahirkan dihitung benar', punyaA?.postedCount === 1, `(${String(punyaA?.postedCount)})`);

console.log(`\n  KEAMANAN: ${String(lulus)} lulus, ${String(gagal)} gagal`);
process.exit(gagal > 0 ? 1 : 0);
