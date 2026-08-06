import { createHash } from 'node:crypto';

import type { KeyProvider } from './index.js';

/**
 * Penyedia kunci.
 *
 * Di produksi ini didukung KMS: kunci privat tidak pernah meninggalkan KMS dan
 * berkas ini hanya memegang penunjuknya. Di pengembangan dan pengujian, kunci
 * diturunkan dari satu rahasia lingkungan.
 *
 * Abstraksinya ada sejak awal — bukan karena dibutuhkan hari ini, tetapi karena
 * menyisipkan KMS ke dalam kode yang sudah memanggil `Buffer` mentah di dua
 * puluh tempat jauh lebih mahal daripada menyediakan satu antarmuka sekarang.
 */

/** Menurunkan kunci berlabel dari satu rahasia induk. */
function derive(master: string, label: string): Buffer {
  return createHash('sha256').update(`${label}:${master}`, 'utf8').digest();
}

export interface KeyMaterial {
  /** Rahasia induk. Di produksi digantikan pemanggilan KMS. */
  master: string;
  /** Versi kunci HMAC yang aktif. Naik satu setiap rotasi. §7.1 */
  activeHmacVersion: number;
}

export function createKeyProvider(material: KeyMaterial): KeyProvider {
  const hmacCache = new Map<number, Buffer>();

  return {
    activeHmacVersion: material.activeHmacVersion,

    hmacKey(version) {
      const cached = hmacCache.get(version);
      if (cached) return cached;

      /* Versi lama tetap dapat dibaca setelah rotasi — itulah gunanya
         menyimpan `hmac_key_version` di setiap baris. §7.1 */
      const key = derive(material.master, `hmac.v${String(version)}`);
      hmacCache.set(version, key);
      return key;
    },

    encryptionKey() {
      return derive(material.master, 'column-encryption');
    },

    ghostKey() {
      return derive(material.master, 'ghost-ticket');
    },
  };
}
