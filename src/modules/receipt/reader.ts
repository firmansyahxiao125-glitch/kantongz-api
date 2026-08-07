import { createWorker, type Worker } from 'tesseract.js';

import { DomainError } from '../../contracts/domain.js';
import type { Logger } from '../../platform/observability/logger.js';
import { parseReceipt, type ReceiptDraft } from './parser.js';

/**
 * Pembaca struk. ROADMAP M6 — Snap-Struk.
 *
 * OCR LOKAL lewat Tesseract yang dikompilasi ke WebAssembly. Tanpa akun, tanpa
 * biaya per gambar, dan — yang lebih penting — tanpa satu pun foto struk
 * meninggalkan mesin. Struk memuat nama, alamat, dan pola belanja seseorang;
 * mengirimkannya ke layanan penglihatan pihak ketiga adalah keputusan yang
 * harus dibuat sadar, bukan bawaan yang tidak pernah ditanyakan.
 *
 * Antarmukanya ada supaya penyedia awan dapat ditambahkan kelak sebagai adaptor
 * tanpa menyentuh satu pun aturan bisnis — pengurainya tetap yang sama, dan
 * penguraiannyalah yang menentukan apakah fitur ini berguna.
 */

export interface ReceiptReader {
  readonly name: string;
  /** Mengubah gambar menjadi rancangan transaksi. */
  read: (image: Buffer) => Promise<ReceiptDraft>;
  /** Melepaskan sumber daya. Pekerja Tesseract memegang instans WASM. */
  close: () => Promise<void>;
}

/** Batas ukuran gambar. Foto ponsel modern 12 MP berukuran sekitar 4 MB; di
 *  atas ini hampir pasti bukan struk, dan OCR-nya akan memakan menit. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Tanda tangan berkas yang diterima. Diperiksa dari ISI, bukan dari nama
 *  maupun `content-type` — keduanya dikendalikan pengunggah. */
const SIGNATURES: readonly { name: string; bytes: readonly number[] }[] = [
  { name: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

/**
 * Memeriksa bahwa isinya benar-benar gambar.
 *
 * Tesseract akan mencoba mengurai apa pun yang diberikan kepadanya, dan berkas
 * yang bukan gambar menghasilkan kegagalan yang lambat alih-alih penolakan yang
 * cepat. Yang lebih penting: ini menutup unggahan berkas sembarang ke proses
 * yang menjalankan WASM.
 */
export function looksLikeImage(image: Buffer): boolean {
  return SIGNATURES.some((signature) =>
    signature.bytes.every((byte, index) => image[index] === byte),
  );
}

export interface TesseractConfig {
  /** Bahasa OCR. `ind` untuk Indonesia; `eng` sebagai cadangan pada struk yang
   *  memakai istilah Inggris. */
  languages: string;
  logger: Logger;
}

/**
 * Pembaca berbasis Tesseract.
 *
 * Pekerjanya dibuat MALAS dan dipakai ulang. Membuat pekerja baru per gambar
 * berarti memuat ulang model bahasa berukuran belasan megabita setiap kali, dan
 * itu memakan detik yang dibayar pengguna pada setiap foto.
 */
export function createTesseractReader(config: TesseractConfig): ReceiptReader {
  let worker: Worker | null = null;
  let starting: Promise<Worker> | null = null;

  /* Satu-jalur: sepuluh unggahan berbarengan pada boot dingin akan membuat
     sepuluh pekerja dan memuat modelnya sepuluh kali. */
  async function ready(): Promise<Worker> {
    if (worker) return worker;

    starting ??= createWorker(config.languages).then((created) => {
      worker = created;
      config.logger.info({ languages: config.languages }, 'pekerja OCR siap');
      return created;
    });

    return starting;
  }

  return {
    name: `tesseract:${config.languages}`,

    read: async (image) => {
      if (image.byteLength === 0) {
        throw new DomainError('invalid_input', 'gambar kosong');
      }
      if (image.byteLength > MAX_IMAGE_BYTES) {
        throw new DomainError('invalid_input', 'gambar terlalu besar');
      }
      if (!looksLikeImage(image)) {
        throw new DomainError('invalid_input', 'berkas bukan gambar');
      }

      const engine = await ready();
      const result = await engine.recognize(image);

      /* Teksnya TIDAK dicatat di log. Struk memuat nama, alamat, dan pola
         belanja — log adalah tempat kedua paling sering bocor setelah dump
         basis data. */
      config.logger.info({ chars: result.data.text.length }, 'struk dibaca');

      return parseReceipt(result.data.text);
    },

    close: async () => {
      const engine = worker;
      worker = null;
      starting = null;
      if (engine) await engine.terminate();
    },
  };
}

/**
 * Pembaca yang tidak tersedia.
 *
 * Melempar `invalid_input` dan bukan galat server: dari sudut pandang klien,
 * fitur yang tidak dipasang dan permintaan yang tidak dapat dilayani terlihat
 * sama, dan keduanya bukan kesalahan server.
 */
export function unavailableReader(reason: string): ReceiptReader {
  return {
    name: 'tidak-tersedia',
    read: () => Promise.reject(new DomainError('invalid_input', reason)),
    close: () => Promise.resolve(),
  };
}
