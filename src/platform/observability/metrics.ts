/**
 * Metrik format Prometheus.
 *
 * ── MENGAPA DITULIS SENDIRI ────────────────────────────────────────────
 *
 * `prom-client` adalah pustaka yang baik dan menambah ~40 dependensi
 * transitif untuk pekerjaan yang di sini berjumlah tiga jenis metrik. Format
 * eksposisi Prometheus adalah teks baris-per-baris yang spesifikasinya muat
 * di satu halaman; menuliskannya sendiri lebih sedikit kode daripada
 * mengonfigurasi pustaka yang menuliskannya.
 *
 * Yang TIDAK dikorbankan: nama metrik, label, dan bentuk histogram mengikuti
 * konvensi Prometheus persis, sehingga Grafana dan aturan peringatan bawaan
 * bekerja tanpa penyesuaian.
 *
 * ── MENGAPA HISTOGRAM, BUKAN RATA-RATA ─────────────────────────────────
 *
 * Latensi rata-rata menyembunyikan tepatnya hal yang perlu dilihat. Sistem
 * yang melayani 99 permintaan dalam 5 ms dan satu dalam 5 detik punya
 * rata-rata 55 ms — angka yang tidak dialami siapa pun. Histogram menyimpan
 * sebaran, dan p95/p99 dihitung darinya di sisi Prometheus.
 *
 * Batas ember dipilih mengikuti latensi yang BENAR-BENAR terukur di
 * `docs/LOAD_TEST.md`: rute daftar hidup di 1–40 ms, rute agregat di 7–240 ms.
 * Ember bawaan pustaka (0.005…10 detik) akan menaruh hampir seluruh trafik
 * ke dalam dua ember pertama dan kehilangan seluruh resolusinya.
 */

/** Detik. Diturunkan dari sebaran latensi yang terukur, bukan dari bawaan. */
const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

interface Histogram {
  /** Hitungan kumulatif per ember, sejajar `LATENCY_BUCKETS`. */
  buckets: number[];
  sum: number;
  count: number;
}

function emptyHistogram(): Histogram {
  /* `Array.from`, bukan `new Array(n).fill(0)` — yang kedua bertipe `any[]`
     dan lolos begitu saja ke `number[]`, yang ditolak lint sebagai penugasan
     tak aman. */
  return { buckets: LATENCY_BUCKETS.map(() => 0), sum: 0, count: 0 };
}

/**
 * Kardinalitas label DIBATASI dengan sengaja.
 *
 * Label dengan nilai tak terbatas — jalur mentah yang memuat ID, alamat IP,
 * agen pengguna — menghasilkan satu deret waktu BARU untuk setiap nilai unik.
 * Prometheus menyimpannya semua, dan basis data metriknya tumbuh lebih cepat
 * daripada basis data aplikasinya. Ini penyebab nomor satu instalasi
 * Prometheus yang tumbang.
 *
 * Karena itu jalur yang dicatat adalah POLA rute (`/v1/transactions/:id`),
 * bukan jalur yang diminta (`/v1/transactions/trx_01K…`).
 */
const state = {
  requests: new Map<string, number>(),
  latency: new Map<string, Histogram>(),
  inFlight: 0,
  startedAt: Date.now(),
};

function key(method: string, route: string, status: number): string {
  return `${method}|${route}|${String(status)}`;
}

/** Dicatat pada setiap balasan. Dipanggil dari hook `onResponse`. */
export function recordRequest(
  method: string,
  route: string,
  status: number,
  durationSeconds: number,
): void {
  const k = key(method, route, status);
  state.requests.set(k, (state.requests.get(k) ?? 0) + 1);

  /* Histogram TIDAK dipisah per status. Memisahkannya menggandakan deret
     waktu tanpa menambah informasi: yang ingin diketahui dari latensi adalah
     sebaran per rute, dan galat sudah terhitung terpisah lewat penghitung. */
  const lk = `${method}|${route}`;
  let h = state.latency.get(lk);
  if (!h) {
    h = emptyHistogram();
    state.latency.set(lk, h);
  }

  h.sum += durationSeconds;
  h.count += 1;
  /* `for…of` dengan `entries()`: `noUncheckedIndexedAccess` memperlakukan
     `LATENCY_BUCKETS[i]` sebagai mungkin-undefined, dan menegaskannya dengan
     `!` akan mematikan pemeriksaan yang justru berguna di tempat lain. */
  for (const [i, bound] of LATENCY_BUCKETS.entries()) {
    if (durationSeconds <= bound) {
      const current = h.buckets[i];
      if (current !== undefined) h.buckets[i] = current + 1;
    }
  }
}

export function requestStarted(): void {
  state.inFlight += 1;
}

export function requestEnded(): void {
  state.inFlight -= 1;
}

/** Melarikan nilai label. Kutip dan garis miring merusak parser Prometheus. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Merender eksposisi Prometheus.
 *
 * Dibangkitkan saat diminta, bukan disimpan sebagai string yang diperbarui —
 * scrape terjadi tiap 15 detik sementara permintaan terjadi ribuan kali di
 * antaranya, dan memperbarui string pada setiap permintaan adalah pekerjaan
 * yang 99,9% terbuang.
 */
export function renderMetrics(): string {
  const lines: string[] = [];
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();

  lines.push('# HELP kantongz_http_requests_total Jumlah permintaan HTTP yang selesai.');
  lines.push('# TYPE kantongz_http_requests_total counter');
  for (const [k, count] of state.requests) {
    /* Nilai bawaan `''` karena `noUncheckedIndexedAccess` memperlakukan hasil
       `split` sebagai mungkin-undefined. Kuncinya selalu dibentuk `key()`
       dengan tiga bagian, jadi cabang ini tidak pernah terpakai — tetapi
       menegaskannya dengan `!` akan mematikan pemeriksaan di seluruh berkas. */
    const [method = '', route = '', status = ''] = k.split('|');
    lines.push(
      `kantongz_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${escapeLabel(status)}"} ${String(count)}`,
    );
  }

  lines.push('# HELP kantongz_http_request_duration_seconds Lama permintaan HTTP.');
  lines.push('# TYPE kantongz_http_request_duration_seconds histogram');
  for (const [k, h] of state.latency) {
    const [method = '', route = ''] = k.split('|');
    const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
    for (const [i, bound] of LATENCY_BUCKETS.entries()) {
      lines.push(
        `kantongz_http_request_duration_seconds_bucket{${labels},le="${String(bound)}"} ${String(h.buckets[i] ?? 0)}`,
      );
    }
    /* Ember `+Inf` WAJIB ada dan harus sama dengan `_count`. Tanpanya
       Prometheus menolak histogramnya sebagai cacat. */
    lines.push(`kantongz_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${String(h.count)}`);
    lines.push(`kantongz_http_request_duration_seconds_sum{${labels}} ${h.sum.toFixed(6)}`);
    lines.push(`kantongz_http_request_duration_seconds_count{${labels}} ${String(h.count)}`);
  }

  lines.push('# HELP kantongz_http_requests_in_flight Permintaan yang sedang diproses.');
  lines.push('# TYPE kantongz_http_requests_in_flight gauge');
  lines.push(`kantongz_http_requests_in_flight ${String(state.inFlight)}`);

  lines.push('# HELP kantongz_process_resident_memory_bytes Memori residen proses.');
  lines.push('# TYPE kantongz_process_resident_memory_bytes gauge');
  lines.push(`kantongz_process_resident_memory_bytes ${String(mem.rss)}`);

  lines.push('# HELP kantongz_process_heap_used_bytes Heap V8 terpakai.');
  lines.push('# TYPE kantongz_process_heap_used_bytes gauge');
  lines.push(`kantongz_process_heap_used_bytes ${String(mem.heapUsed)}`);

  lines.push('# HELP kantongz_process_cpu_seconds_total Waktu CPU proses.');
  lines.push('# TYPE kantongz_process_cpu_seconds_total counter');
  lines.push(`kantongz_process_cpu_seconds_total ${((cpu.user + cpu.system) / 1e6).toFixed(3)}`);

  lines.push('# HELP kantongz_process_uptime_seconds Lama proses hidup.');
  lines.push('# TYPE kantongz_process_uptime_seconds gauge');
  lines.push(`kantongz_process_uptime_seconds ${((Date.now() - state.startedAt) / 1000).toFixed(1)}`);

  /* Baris kosong penutup. Format eksposisi menuntutnya. */
  return lines.join('\n') + '\n';
}

/** Hanya untuk uji. Keadaan modul bersifat global dan harus dapat dibersihkan. */
export function resetMetrics(): void {
  state.requests.clear();
  state.latency.clear();
  state.inFlight = 0;
}
