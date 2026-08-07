/**
 * Penyedia model bahasa. ROADMAP M11 dan M13.
 *
 * Antarmuka ini ada supaya seluruh sisa lapisan asisten dapat dibangun,
 * diuji, dan dijalankan tanpa kredensial — dan supaya menyambungkannya nanti
 * tidak menuntut perubahan di mana pun selain satu berkas perakitan.
 *
 * KEPUTUSAN YANG TIDAK DITAWAR: model TIDAK PERNAH menerima data pribadi.
 * Yang dikirim adalah angka agregat yang sudah dihitung server — total per
 * kategori, arus bersih, rasio anggaran. Tidak ada nama, tidak ada email, tidak
 * ada nama merchant, tidak ada id. Konsekuensinya jawabannya kurang spesifik,
 * dan itu harga yang dibayar dengan sadar: UU PDP memperlakukan riwayat
 * transaksi sebagai data pribadi, dan penyedia model adalah pihak ketiga.
 */

export interface LanguageModelRequest {
  /** Instruksi peran. Tidak pernah memuat data pengguna. */
  system: string;
  /** Pertanyaan atau permintaan, sudah dibersihkan pemanggil. */
  prompt: string;
  /** Batas panjang jawaban. Jawaban panjang pada layar ponsel tidak dibaca. */
  maxTokens: number;
}

export interface LanguageModel {
  /** Nama penyedia, untuk log dan pemeriksaan kesehatan. */
  readonly name: string;
  /** `false` berarti kredensialnya belum ada. Pemanggil memakai jalur
   *  deterministik dan MENGATAKANNYA kepada pengguna. */
  readonly available: boolean;
  complete: (request: LanguageModelRequest) => Promise<string>;
}

/**
 * Penyedia yang tidak tersedia.
 *
 * Melempar bila dipanggil, dan itu disengaja: jalur yang membutuhkan model
 * harus memeriksa `available` lebih dulu, dan yang lupa memeriksanya harus
 * gagal keras di pengembangan alih-alih mengembalikan kalimat kosong yang
 * terlihat seperti jawaban.
 */
export function unavailableModel(reason: string): LanguageModel {
  return {
    name: 'tidak-tersedia',
    available: false,
    complete: () => Promise.reject(new Error(`model tidak tersedia: ${reason}`)),
  };
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
}

/**
 * Penyedia Anthropic lewat Messages API.
 *
 * Ditulis sebagai `fetch` langsung dan bukan lewat SDK: satu permintaan POST
 * dengan tiga bidang tidak cukup untuk membenarkan dependensi yang harus ikut
 * ke setiap build dan setiap pemindaian keamanan.
 */
export function createAnthropicModel(config: AnthropicConfig): LanguageModel {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  return {
    name: `anthropic:${config.model}`,
    available: true,

    complete: async (request) => {
      const response = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
        }),
      });

      if (!response.ok) {
        /* Badan respons TIDAK dibaca ke dalam pesan galat: ia menggemakan
           kembali permintaannya, dan permintaannya — meski sudah agregat —
           tetap menggambarkan keuangan seseorang. */
        throw new Error(`penyedia model menolak: HTTP ${String(response.status)}`);
      }

      const body = (await response.json()) as AnthropicResponse;
      const text = (body.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim();

      if (text.length === 0) throw new Error('penyedia model mengembalikan jawaban kosong');
      return text;
    },
  };
}
