#!/usr/bin/env node
/**
 * Uji beban lokal.
 *
 * ── MENGAPA DITULIS SENDIRI ────────────────────────────────────────────
 *
 * autocannon dan k6 keduanya baik, dan keduanya menambah dependensi untuk
 * pekerjaan yang seluruhnya dapat dikerjakan `fetch` bawaan Node 22. Yang
 * dibutuhkan di sini adalah beban ber-otentikasi terhadap rute yang benar,
 * dengan persentil yang dihitung dari sampel penuh — bukan kerangka kerja.
 *
 * Yang TIDAK dilakukan alat ini, dan disebutkan supaya tidak dibaca lebih
 * jauh daripada yang berhak:
 *   - ia berjalan di MESIN YANG SAMA dengan peladen, jadi klien dan peladen
 *     berebut CPU. Angkanya adalah batas bawah, bukan kapasitas sebenarnya;
 *   - tanpa jaringan sungguhan, latensinya tidak memuat RTT;
 *   - `dev:standalone` memakai PGlite dalam proses, BUKAN PostgreSQL
 *     sungguhan. Karakter I/O-nya berbeda.
 *
 * Angka dari sini berguna untuk MEMBANDINGKAN (sebelum/sesudah perubahan) dan
 * untuk menemukan titik jenuh. Ia BUKAN pengganti uji beban terhadap susunan
 * produksi.
 *
 *   node scripts/loadtest.mjs --base http://localhost:3000 --seconds 20
 */

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const BASE = arg('base', 'http://localhost:3000');
const SECONDS = Number(arg('seconds', '15'));
/* Naik bertahap, bukan langsung ke puncak. Beban yang melompat dari nol ke
   200 mengukur perilaku start-dingin — kolam koneksi yang belum terisi, JIT
   yang belum panas — dan bukan kapasitas keadaan tunak. */
const LEVELS = (arg('levels', '1,4,8,16,32,64') ?? '').split(',').map(Number);
/* Mode standalone MENCETAK kode verifikasi ke stdout — tidak ada kotak surat
   untuk dibaca. Uji membacanya dari berkas log peladen alih-alih menuntut
   manusia menyalinnya, karena langkah manual di tengah uji beban berarti uji
   beban itu tidak akan dijalankan dua kali. */
const LOGFILE = arg('logfile', null);
/* Kode verifikasi dapat diberikan langsung — dipakai ketika peladen mengirim
   surel sungguhan ke Mailpit alih-alih mencetak ke stdout. */
const MAILPIT = arg('mailpit', null);
/* Token yang sudah jadi. Dipakai terhadap susunan PRODUKSI, yang sengaja tidak
   menjalankan Mailpit dan menyensor kode verifikasi dari log — jadi tidak ada
   jalur otomatis untuk memperolehnya, dan memaksakannya akan menuntut
   mengubah konfigurasi produksi hanya demi pengujian. */
const TOKEN = arg('token', null);

/* Sertifikat CA-internal Caddy tidak dipercayai secara bawaan.
   
   Diterima HANYA ketika sasarannya localhost. Terhadap domain sungguhan,
   sertifikat yang tidak sah HARUS tetap menggagalkan uji — alat ukur yang
   diam-diam menerima TLS palsu akan melaporkan sukses atas koneksi yang
   sedang disadap. */
if (BASE.startsWith('https://localhost')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/* ── persentil ────────────────────────────────────────────────────────── */

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  /* Interpolasi linear. Metode "ambil indeks terdekat" menggeser p99 ke
     bawah pada sampel kecil, dan p99 yang terlalu murah hati persis nilai
     yang paling sering dikutip. */
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/* ── penyiapan akun ───────────────────────────────────────────────────── */

async function call(path, { method = 'POST', body, token } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/**
 * Akun uji dibuat lewat API yang sama dengan pengguna sungguhan.
 *
 * Menyuntik baris langsung ke basis data akan melewati argon2id — dan
 * argon2id adalah bagian termahal dari alur masuk. Uji beban yang melewatinya
 * mengukur sistem yang berbeda dari yang dijalankan.
 */
async function setup() {
  const email = `beban-${String(Date.now())}@contoh.id`;
  const device = { deviceId: `beban-${String(Date.now())}`, platform: 'web' };

  const reg = await call('/v1/auth/register', {
    body: { fullName: 'Uji Beban', email, password: 'kantongz-sandi-kuat', device },
  });
  if (reg.status !== 201) throw new Error(`pendaftaran gagal: ${String(reg.status)}`);

  /* Mode standalone mencetak kode ke terminal alih-alih mengirim surel.
     Rute dev khusus memberikannya kembali supaya uji dapat berjalan tanpa
     manusia membaca log. */
  let code = process.env.KANTONGZ_DEV_CODE ?? null;

  if (!code && MAILPIT) {
    /* Dijajal berulang: pekerja outbox berjalan pada interval. */
    for (let attempt = 0; attempt < 60 && !code; attempt += 1) {
      const res = await fetch(`${MAILPIT}/api/v1/messages?limit=50`);
      const box = await res.json();
      for (const m of box.messages ?? []) {
        const to = (m.To ?? []).map((a) => a.Address).join(' ');
        if (!to.includes(email)) continue;
        const full = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
        const hit = /\b\d{6}\b/.exec(full.Text ?? full.HTML ?? '');
        if (hit) { code = hit[0]; break; }
      }
      if (!code) await sleep(400);
    }
  }

  if (!code && LOGFILE) {
    /* Dijajal berulang: pekerja outbox berjalan pada interval, jadi barisnya
       belum tentu ada pada pembacaan pertama. Tidur sekali lalu memeriksa
       sekali akan gagal secara acak. */
    for (let attempt = 0; attempt < 40 && !code; attempt += 1) {
      const log = readFileSync(LOGFILE, 'utf8');
      const hits = [...log.matchAll(/VERIFY\s+(\S+)\s+→ kode (\d{4,8})/g)];
      const mine = hits.filter(([, to]) => to === email).at(-1);
      if (mine) code = mine[2];
      else await sleep(300);
    }
  }

  if (!code) {
    throw new Error(
      [
        'kode verifikasi tidak tersedia. Jalankan peladen dengan keluaran diarahkan ke berkas:',
        '  npm run dev:standalone > server.log 2>&1 &',
        'lalu: node scripts/loadtest.mjs --logfile server.log',
      ].join('\n'),
    );
  }

  const ver = await call('/v1/auth/verify', {
    body: { ticket: reg.json.data.ticket, code, device },
  });
  if (ver.status !== 200) throw new Error(`verifikasi gagal: ${String(ver.status)}`);

  const token = ver.json.data.tokens.accessToken;

  const acc = await call('/v1/accounts', {
    body: { name: 'Dompet Beban', kind: 'cash', openingBalance: 50_000_000 },
    token,
  });
  const cats = await call('/v1/categories', { method: 'GET', token });
  const cat = cats.json.data.find((c) => c.kind === 'expense');

  /* Data yang cukup supaya kueri agregat benar-benar bekerja. Dasbor di atas
     tabel kosong mengukur biaya rute, bukan biaya kueri. */
  const now = Date.now();
  for (let i = 0; i < 120; i += 1) {
    await call('/v1/transactions', {
      body: {
        accountId: acc.json.data.id,
        categoryId: cat.id,
        kind: 'expense',
        amount: 45_000 + (i % 7) * 3_000,
        occurredAt: now - i * 86_400_000,
        merchant: i % 5 === 0 ? 'Netflix' : 'Warung',
      },
      token,
    });
  }

  return token;
}

/* ── satu tingkat beban ───────────────────────────────────────────────── */

async function level({ token, concurrency, seconds, path }) {
  const latencies = [];
  let ok = 0;
  let failed = 0;
  const statuses = new Map();

  const until = Date.now() + seconds * 1000;
  const cpuStart = process.cpuUsage();
  const started = Date.now();

  async function worker() {
    while (Date.now() < until) {
      const t0 = performance.now();
      try {
        const res = await fetch(`${BASE}${path}`, {
          headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        });
        const dt = performance.now() - t0;
        /* Badan HARUS dibaca sampai habis. Balasan yang tidak dibaca
           menyisakan soket dalam keadaan setengah selesai, dan Node akan
           menahan koneksinya — mengukur throughput yang tidak pernah terjadi. */
        await res.arrayBuffer();

        latencies.push(dt);
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        if (res.ok) ok += 1;
        else failed += 1;
      } catch {
        failed += 1;
        statuses.set(0, (statuses.get(0) ?? 0) + 1);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const elapsed = (Date.now() - started) / 1000;
  const cpu = process.cpuUsage(cpuStart);
  latencies.sort((a, b) => a - b);

  return {
    concurrency,
    total: ok + failed,
    ok,
    failed,
    rps: (ok + failed) / elapsed,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.at(-1) ?? 0,
    errorRate: (ok + failed) === 0 ? 0 : failed / (ok + failed),
    /* CPU KLIEN, bukan peladen. Disebutkan apa adanya karena keduanya berbagi
       mesin — klien yang jenuh membatasi beban sebelum peladen jenuh. */
    clientCpuSeconds: (cpu.user + cpu.system) / 1e6,
    statuses: Object.fromEntries(statuses),
  };
}

/* ── alur ─────────────────────────────────────────────────────────────── */

const PATHS = [
  ['/v1/dashboard', 'dasbor — agregat terberat'],
  ['/v1/transactions?limit=20', 'daftar transaksi — pagination kursor'],
  ['/v1/insights', 'wawasan — z-score, langganan, regresi'],
];

console.log(`\nUji beban → ${BASE}`);
console.log(`Tingkat: ${LEVELS.join(', ')} serentak · ${String(SECONDS)}s per tingkat\n`);

/* Token yang diberikan MELEWATI penyiapan akun sepenuhnya.

   Dibutuhkan terhadap susunan produksi, yang sengaja tidak menjalankan Mailpit
   dan menyensor kode verifikasi dari log — jadi tidak ada jalur otomatis untuk
   memperolehnya, dan memaksakannya akan menuntut mengubah konfigurasi produksi
   hanya demi pengujian. */
const token = TOKEN ?? (await setup());
console.log('Akun dan 120 transaksi disiapkan.\n');

for (const [path, label] of PATHS) {
  console.log(`\n══ ${path}`);
  console.log(`   ${label}\n`);
  console.log(
    '   konkurensi |     rps |    p50 |    p95 |    p99 |    maks | galat | status',
  );
  console.log('   ' + '─'.repeat(78));

  for (const concurrency of LEVELS) {
    const r = await level({ token, concurrency, seconds: SECONDS, path });
    console.log(
      `   ${String(r.concurrency).padStart(10)} | ${r.rps.toFixed(0).padStart(7)} | ` +
        `${r.p50.toFixed(1).padStart(6)} | ${r.p95.toFixed(1).padStart(6)} | ` +
        `${r.p99.toFixed(1).padStart(6)} | ${r.max.toFixed(1).padStart(7)} | ` +
        `${(r.errorRate * 100).toFixed(1).padStart(4)}% | ${JSON.stringify(r.statuses)}`,
    );

    /* Jeda antar tingkat. Tanpa ini, antrean dari tingkat sebelumnya masih
       terurai saat tingkat berikutnya mulai, dan angka pertamanya tercemar. */
    await sleep(1500);
  }
}

console.log('\nSatuan latensi: milidetik. rps dihitung dari total permintaan / durasi.\n');
console.log(
  'PERINGATAN PEMBACAAN: klien dan peladen berbagi mesin ini, jadi angkanya\n' +
    'adalah BATAS BAWAH. Mode standalone memakai PGlite dalam proses, bukan\n' +
    'PostgreSQL sungguhan — karakter I/O-nya berbeda.\n',
);
