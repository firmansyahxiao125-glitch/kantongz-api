import { generateKeyPairSync, randomBytes } from 'node:crypto';

/**
 * Membangkitkan bahan rahasia untuk pengembangan lokal.
 *
 * Keluarannya sengaja dicetak ke stdout dan bukan ditulis ke `.env`: rahasia
 * yang ditulis diam-diam ke berkas adalah rahasia yang suatu hari ikut
 * ter-commit. Operator menyalinnya sendiri, dan tahu persis apa yang disalin.
 *
 * Di produksi kunci ini datang dari KMS. Skrip ini TIDAK boleh dipakai untuk
 * membangkitkan kunci produksi — ia menulis kunci privat ke terminal, dan
 * terminal punya riwayat.
 */

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/* PEM dilipat menjadi satu baris dengan `\n` harfiah — `loadConfig`
   memulihkannya, dan variabel lingkungan berbaris banyak tidak selamat melewati
   sebagian orkestrator. */
const fold = (pem) => pem.trim().replaceAll('\n', String.raw`\n`);

process.stdout.write(
  [
    `JWT_PRIVATE_KEY=${fold(privateKey)}`,
    `JWT_PUBLIC_KEY=${fold(publicKey)}`,
    `MASTER_KEY=${randomBytes(32).toString('base64url')}`,
    'HMAC_KEY_VERSION=1',
    '',
  ].join('\n'),
);
