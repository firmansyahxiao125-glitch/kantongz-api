import type { LanguageModel, LanguageModelRequest } from './provider.js';

/**
 * Penyedia model LOKAL lewat Ollama. ROADMAP M11 dan M13.
 *
 * Ini adalah penyedia BAWAAN. Bukan karena kualitasnya melampaui model berbayar
 * — tidak — melainkan karena keseluruhan proyek ini harus dapat dijalankan
 * seorang pengembang di satu mesin, tanpa akun, tanpa kartu kredit, dan tanpa
 * satu pun byte data keuangan meninggalkan mesinnya.
 *
 * Yang terakhir itu bukan efek samping: riwayat transaksi adalah data pribadi
 * menurut UU PDP, dan penyedia model di internet adalah pihak ketiga. Inferensi
 * lokal menghapus seluruh pertanyaan itu.
 *
 * Ollama tidak selalu berjalan, dan itu normal. `available` menjawab apakah ia
 * ADA — bukan apakah ia dikonfigurasi — dan lapisan di atasnya jatuh ke templat
 * tanpa satu pun kegagalan yang terlihat pengguna.
 */

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  /** Batas waktu. Inferensi lokal di CPU bisa memakan puluhan detik pada model
   *  besar, dan permintaan yang menggantung lebih buruk daripada templat. */
  timeoutMs: number;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

interface OllamaTagsResponse {
  models?: { name?: string }[];
}

/**
 * Memeriksa apakah Ollama hidup DAN modelnya sudah diunduh.
 *
 * Keduanya, bukan salah satu. Ollama yang berjalan tanpa model yang diminta
 * akan menerima permintaan lalu menolaknya beberapa detik kemudian — dan
 * beberapa detik itu dibayar pengguna pada setiap permintaan ringkasan.
 */
export async function probeOllama(config: OllamaConfig): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 2_000);

  try {
    const response = await fetch(`${config.baseUrl}/api/tags`, { signal: controller.signal });
    if (!response.ok) return false;

    const body = (await response.json()) as OllamaTagsResponse;
    const names = (body.models ?? []).map((m) => m.name ?? '');

    /* Nama model di Ollama membawa tag (`llama3.2:3b`). Konfigurasi boleh
       menyebutnya tanpa tag, dan `latest` adalah tag implisitnya. */
    return names.some((name) => name === config.model || name.startsWith(`${config.model}:`));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createOllamaModel(config: OllamaConfig, available: boolean): LanguageModel {
  const base = config.baseUrl.replace(/\/+$/, '');

  return {
    name: `ollama:${config.model}`,
    available,

    complete: async (request: LanguageModelRequest) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, config.timeoutMs);

      try {
        const response = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            /* `stream: false` — pemanggil menunggu kalimat utuh, dan
               menyalurkan potongan lewat lapisan ini hanya menambah keadaan
               tanpa menambah manfaat. */
            stream: false,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.prompt },
            ],
            options: {
              num_predict: request.maxTokens,
              /* Rendah, bukan nol. Ringkasan keuangan tidak boleh berbunga-bunga,
                 tetapi nol menghasilkan kalimat yang identik setiap minggu dan
                 pengguna berhenti membacanya. */
              temperature: 0.3,
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`ollama menolak: HTTP ${String(response.status)}`);
        }

        const body = (await response.json()) as OllamaChatResponse;
        const text = (body.message?.content ?? '').trim();

        if (text.length === 0) throw new Error('ollama mengembalikan jawaban kosong');
        return text;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
