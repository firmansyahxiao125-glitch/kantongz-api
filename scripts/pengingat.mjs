/**
 * Gerbang G1 — pengingat jatuh tempo, DIBUKTIKAN sampai ke kotak masuk.
 *
 * ── MENGAPA GERBANG TERPISAH, PADAHAL SUDAH ADA 22 UJI ─────────────────
 *
 * Uji satuan membuktikan perencananya benar dan indeks uniknya menggigit.
 * Tidak satu pun membuktikan rantai yang sebenarnya dipakai orang: pekerja
 * berjalan sendiri di dalam proses, pemindai membaca aturan sungguhan,
 * outbox mengirimnya lewat SMTP, dan sebuah email benar-benar mendarat.
 *
 * Setiap sambungan di rantai itu pernah putus tanpa satu uji pun memerah —
 * kunci enkripsi yang tidak diteruskan ke pekerja, topik yang tidak punya
 * templat, pekerja yang tidak pernah dinyalakan di `bootstrap`.
 *
 * ── DAN MENGAPA DUA PUTARAN, BUKAN SATU ────────────────────────────────
 *
 * Satu email yang mendarat hanya membuktikan pengiriman. Yang dijanjikan G1
 * adalah TEPAT SATU, jadi yang harus diukur adalah keadaan sesudah pekerja
 * berjalan berkali-kali — dan angkanya harus tidak bergerak.
 */

const API = process.argv.includes('--api')
  ? process.argv[process.argv.indexOf('--api') + 1]
  : 'http://localhost:3000';
const MAILPIT = process.argv.includes('--mailpit')
  ? process.argv[process.argv.indexOf('--mailpit') + 1]
  : 'http://localhost:8025';

let lulus = 0;
let gagal = 0;

function ok(nama, syarat, catatan = '') {
  if (syarat) {
    lulus += 1;
    console.log(`  OK    ${nama} ${catatan}`);
  } else {
    gagal += 1;
    console.log(`  GAGAL ${nama} ${catatan}`);
  }
}

async function json(res) {
  const teks = await res.text();
  try {
    return JSON.parse(teks);
  } catch {
    throw new Error(`bukan JSON (${res.status}): ${teks.slice(0, 200)}`);
  }
}

/** Tanggal lokal Jakarta, digeser sekian hari. */
function tanggal(geser = 0) {
  const d = new Date(Date.now() + geser * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Surat untuk satu alamat.
 *
 * Lewat `/api/v1/messages`, bukan `/api/v1/search`. Bentuk kueri pencarian
 * Mailpit berbeda antar versi; daftar mentah lalu disaring di sini adalah
 * jalan yang sudah terbukti dipakai `security.mjs` dan `loadtest.mjs`.
 */
async function pesanUntuk(alamat) {
  const box = await json(await fetch(`${MAILPIT}/api/v1/messages?limit=100`));
  return (box.messages ?? []).filter((m) =>
    (m.To ?? []).map((a) => a.Address).join(' ').includes(alamat),
  );
}

async function kodeUntuk(alamat) {
  for (let i = 0; i < 60; i += 1) {
    for (const m of await pesanUntuk(alamat)) {
      const isi = await json(await fetch(`${MAILPIT}/api/v1/message/${m.ID}`));
      const cocok = /\b\d{6}\b/.exec(`${isi.Text ?? ''}${isi.HTML ?? ''}`);
      if (cocok) return cocok[0];
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('kode verifikasi tidak pernah datang');
}

const DEVICE = { deviceId: `gerbang-pengingat-${Date.now()}`, platform: 'web' };

async function main() {
  console.log(`Gerbang G1 · pengingat jatuh tempo → ${API}\n`);

  const alamat = `pengingat-${Date.now()}@contoh.id`;
  const sandi = 'kantongz-sandi-kuat';

  /* ── akun sungguhan ─────────────────────────────────────────────────── */

  const daftar = await json(
    await fetch(`${API}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: 'Penguji Pengingat', email: alamat, password: sandi, device: DEVICE }),
    }),
  );

  const kode = await kodeUntuk(alamat);
  const sesi = await json(
    await fetch(`${API}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: daftar.data.ticket, code: kode, device: DEVICE }),
    }),
  );
  const token = sesi.data.tokens.accessToken;
  ok('akun uji terbuat dan terverifikasi', typeof token === 'string' && token.length > 0);

  const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  const dompet = await json(
    await fetch(`${API}/v1/accounts`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Kas Uji', kind: 'cash' }),
    }),
  );

  /* ── aturan yang jatuh tempo DI DALAM ufuk ──────────────────────────── */

  const aturan = await json(
    await fetch(`${API}/v1/recurring`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'Langganan Gerbang',
        accountId: dompet.data.id,
        kind: 'expense',
        amount: 350_000,
        cadence: 'monthly',
        interval: 1,
        /* Dua hari lagi: di dalam ufuk tiga hari, dan TIDAK jatuh tempo hari
           ini — supaya pekerja berulang tidak mencatatnya lalu memajukan
           tanggalnya di tengah pengukuran. */
        startsOn: tanggal(2),
      }),
    }),
  );
  ok('aturan berulang terbuat', typeof aturan.data?.id === 'string', tanggal(2));

  /* ── menunggu pekerja ───────────────────────────────────────────────── */

  console.log('\n  … menunggu putaran pekerja (jeda 60 detik)');

  let pengingat = [];
  for (let i = 0; i < 150; i += 1) {
    pengingat = (await pesanUntuk(alamat)).filter((p) => /jatuh tempo/i.test(p.Subject));
    if (pengingat.length > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  ok('pengingat MENDARAT di kotak masuk', pengingat.length >= 1, `${pengingat.length} surat`);

  if (pengingat.length > 0) {
    const isi = await json(await fetch(`${MAILPIT}/api/v1/message/${pengingat[0].ID}`));
    const teks = isi.Text ?? '';

    ok('menyebut nama tagihannya', teks.includes('Langganan Gerbang'));
    ok('menyebut nominalnya dalam rupiah bulat', /Rp\s?350\.000/.test(teks), 'Rp 350.000');
    ok('menyebut kapan jatuh temponya', /2 hari lagi/.test(teks));
    ok('TIDAK memuat satu pun tautan', !/https?:\/\//.test(teks));
  }

  /* ── dan tetap SATU sesudah putaran-putaran berikutnya ──────────────── */

  console.log('\n  … menunggu dua putaran berikutnya (130 detik)');
  await new Promise((r) => setTimeout(r, 130_000));

  const sesudah = (await pesanUntuk(alamat)).filter((p) => /jatuh tempo/i.test(p.Subject));
  ok(
    'TETAP satu pengingat sesudah tiga putaran',
    sesudah.length === pengingat.length && sesudah.length === 1,
    `${sesudah.length} surat`,
  );

  console.log(`\n  G1: ${lulus} lulus, ${gagal} gagal`);
  if (gagal > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`\nGERBANG GAGAL: ${error.message}`);
  process.exit(1);
});
