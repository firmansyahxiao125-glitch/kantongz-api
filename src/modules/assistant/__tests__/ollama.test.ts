import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createOllamaModel, probeOllama, type OllamaConfig } from '../ollama.js';

/**
 * Penyedia model LOKAL — diuji terhadap peladen HTTP SUNGGUHAN.
 *
 * ── MENGAPA UJI INI ADA ────────────────────────────────────────────────
 *
 * Berkas `ollama.ts` sebelumnya adalah SATU-SATUNYA modul asisten tanpa satu
 * pun uji, dan yang tidak diuji di sini justru jalur yang paling sulit
 * diperhatikan ketika rusak: kalau `probeOllama` keliru menjawab `false`,
 * aplikasi tidak menampilkan satu pun galat. Ia hanya diam-diam memakai
 * templat selamanya — dan gejalanya adalah fitur yang "tidak pernah bekerja"
 * tanpa ada yang bisa menunjuk sebabnya.
 *
 * Sebaliknya, kalau ia keliru menjawab `true`, setiap permintaan ringkasan
 * membayar batas waktu penuh sebelum jatuh ke templat.
 *
 * ── MENGAPA PELADEN SUNGGUHAN, BUKAN `fetch` YANG DITIRU ───────────────
 *
 * Alasan yang sama mengapa suite ini memakai PGlite alih-alih basis data
 * tiruan: tiruan selalu setuju. `fetch` yang ditiru tidak akan pernah
 * menunjukkan bahwa `AbortController` tidak tersambung, bahwa badan JSON
 * dibaca dua kali, atau bahwa jalur URL-nya salah — dan ketiganya adalah cacat
 * yang nyata mungkin terjadi di berkas ini.
 */

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => { resolve(); }));
    server = undefined;
  }
});

interface Recorded {
  path: string;
  body: unknown;
}

/** Menyalakan peladen palsu-Ollama dan mengembalikan konfigurasi yang menunjuk ke sana. */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse, recorded: Recorded[]) => void,
  overrides: Partial<OllamaConfig> = {},
): Promise<{ config: OllamaConfig; recorded: Recorded[] }> {
  const recorded: Recorded[] = [];

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      recorded.push({
        path: req.url ?? '',
        body: raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined,
      });
      handler(req, res, recorded);
    });
  });

  await new Promise<void>((resolve) => { server?.listen(0, '127.0.0.1', () => { resolve(); }); });
  const port = (server.address() as AddressInfo).port;

  return {
    recorded,
    config: {
      baseUrl: `http://127.0.0.1:${String(port)}`,
      model: 'llama3.2',
      timeoutMs: 2_000,
      ...overrides,
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/* ── probe ────────────────────────────────────────────────────────────── */

describe('probeOllama', () => {
  it('mengenali model yang namanya membawa tag', async () => {
    /* Ollama menamai modelnya `llama3.2:3b`; konfigurasi menyebutnya tanpa tag.
       Perbandingan yang persis-sama akan MELEWATKAN setiap model yang benar. */
    const { config } = await serve((_req, res) => {
      json(res, 200, { models: [{ name: 'qwen2:7b' }, { name: 'llama3.2:3b' }] });
    });
    expect(await probeOllama(config)).toBe(true);
  });

  it('mengenali model tanpa tag', async () => {
    const { config } = await serve((_req, res) => {
      json(res, 200, { models: [{ name: 'llama3.2' }] });
    });
    expect(await probeOllama(config)).toBe(true);
  });

  it('menolak ketika modelnya BELUM diunduh', async () => {
    /* Ollama hidup, tetapi model yang diminta tidak ada. Menerima ini sebagai
       "tersedia" berarti setiap ringkasan membayar batas waktu penuh sebelum
       jatuh ke templat. */
    const { config } = await serve((_req, res) => {
      json(res, 200, { models: [{ name: 'qwen2:7b' }] });
    });
    expect(await probeOllama(config)).toBe(false);
  });

  it('menolak daftar model yang kosong', async () => {
    const { config } = await serve((_req, res) => { json(res, 200, {}); });
    expect(await probeOllama(config)).toBe(false);
  });

  it('menolak ketika peladen menjawab galat', async () => {
    const { config } = await serve((_req, res) => { json(res, 500, { error: 'aduh' }); });
    expect(await probeOllama(config)).toBe(false);
  });

  it('menolak ketika badan bukan JSON', async () => {
    const { config } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('bukan json sama sekali');
    });
    expect(await probeOllama(config)).toBe(false);
  });

  it('menolak ketika tidak ada yang mendengarkan — dan TIDAK melempar', async () => {
    /* Ollama yang tidak berjalan adalah keadaan NORMAL, bukan kegagalan.
       Kalau probe melempar, boot API ikut gagal — dan aplikasi berhenti
       bekerja karena fitur opsional tidak dipasang. */
    const config: OllamaConfig = {
      baseUrl: 'http://127.0.0.1:1',
      model: 'llama3.2',
      timeoutMs: 2_000,
    };
    await expect(probeOllama(config)).resolves.toBe(false);
  });

  it('memeriksa /api/tags, bukan jalur lain', async () => {
    const { config, recorded } = await serve((_req, res) => {
      json(res, 200, { models: [{ name: 'llama3.2' }] });
    });
    await probeOllama(config);
    expect(recorded[0]?.path).toBe('/api/tags');
  });
});

/* ── penyelesaian ─────────────────────────────────────────────────────── */

describe('createOllamaModel', () => {
  it('mengirim system dan prompt sebagai dua pesan, tanpa aliran', async () => {
    const { config, recorded } = await serve((_req, res) => {
      json(res, 200, { message: { content: 'Bulan ini pengeluaranmu naik.' } });
    });

    const model = createOllamaModel(config, true);
    const text = await model.complete({
      system: 'Kamu penyusun kalimat ringkasan.',
      prompt: 'pengeluaran 78000',
      maxTokens: 120,
    });

    expect(text).toBe('Bulan ini pengeluaranmu naik.');
    expect(recorded[0]?.path).toBe('/api/chat');

    const body = recorded[0]?.body as {
      model: string;
      stream: boolean;
      messages: { role: string; content: string }[];
      options: { num_predict: number; temperature: number };
    };
    expect(body.model).toBe('llama3.2');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: 'system', content: 'Kamu penyusun kalimat ringkasan.' },
      { role: 'user', content: 'pengeluaran 78000' },
    ]);
    expect(body.options.num_predict).toBe(120);
  });

  it('memangkas ruang kosong di sekeliling jawaban', async () => {
    const { config } = await serve((_req, res) => {
      json(res, 200, { message: { content: '\n\n  Saldomu aman.  \n' } });
    });
    const model = createOllamaModel(config, true);
    expect(await model.complete({ system: 's', prompt: 'p', maxTokens: 10 })).toBe('Saldomu aman.');
  });

  it('melempar ketika Ollama menolak, dengan kode statusnya', async () => {
    const { config } = await serve((_req, res) => { json(res, 404, { error: 'model tidak ada' }); });
    const model = createOllamaModel(config, true);
    await expect(model.complete({ system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('melempar ketika jawabannya kosong', async () => {
    /* Kalimat kosong yang diteruskan apa adanya akan tampil di layar sebagai
       ringkasan yang hilang — tanpa satu pun galat yang menjelaskannya.
       Melempar membuat pemanggil jatuh ke templat, yang selalu berisi. */
    const { config } = await serve((_req, res) => { json(res, 200, { message: { content: '   ' } }); });
    const model = createOllamaModel(config, true);
    await expect(model.complete({ system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(
      /kosong/,
    );
  });

  it('melempar ketika badan tidak memuat pesan sama sekali', async () => {
    const { config } = await serve((_req, res) => { json(res, 200, { tidak: 'terduga' }); });
    const model = createOllamaModel(config, true);
    await expect(model.complete({ system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow();
  });

  it('MEMBATALKAN permintaan yang melewati batas waktu', async () => {
    /* Inferensi lokal di CPU bisa menggantung. Tanpa pembatalan yang benar-benar
       tersambung, permintaan ringkasan menunggu selamanya — dan pengguna
       melihat pemuat yang tidak pernah selesai. Batas waktu yang ada di
       konfigurasi tetapi tidak tersambung adalah cacat yang tidak terlihat
       sampai model pertama yang lambat dipasang. */
    const { config } = await serve(
      () => {
        /* Sengaja tidak pernah menjawab. */
      },
      { timeoutMs: 250 },
    );

    const model = createOllamaModel(config, true);
    const mulai = Date.now();
    await expect(model.complete({ system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow();
    expect(Date.now() - mulai).toBeLessThan(2_000);
  });

  it('membawa `available` apa adanya — perakitan yang memutuskan, bukan berkas ini', async () => {
    const { config } = await serve((_req, res) => { json(res, 200, { message: { content: 'ya' } }); });
    expect(createOllamaModel(config, false).available).toBe(false);
    expect(createOllamaModel(config, true).available).toBe(true);
    expect(createOllamaModel(config, true).name).toBe('ollama:llama3.2');
  });

  it('menormalkan garis miring berlebih pada baseUrl', async () => {
    const { config, recorded } = await serve((_req, res) => {
      json(res, 200, { message: { content: 'ya' } });
    });
    const model = createOllamaModel({ ...config, baseUrl: `${config.baseUrl}///` }, true);
    await model.complete({ system: 's', prompt: 'p', maxTokens: 10 });
    expect(recorded[0]?.path).toBe('/api/chat');
  });
});
