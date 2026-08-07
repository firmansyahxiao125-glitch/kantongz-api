import { DomainError } from '../../contracts/domain.js';

/**
 * Uang.
 *
 * Satu tempat yang tahu berapa desimal setiap mata uang punya, dan satu-satunya
 * tempat yang boleh mengubah teks menjadi bilangan. Konversi yang ditulis di
 * tempat pemakaian akan berbeda-beda pembulatannya, dan selisih pembulatan pada
 * uang bukan ketidaksempurnaan melainkan cacat.
 */

/**
 * Berapa angka di belakang koma yang BEREDAR, bukan yang ditetapkan ISO 4217.
 *
 * IDR bernilai 2 menurut ISO 4217, tetapi sen rupiah tidak pernah dipakai dalam
 * pembayaran maupun pembukuan sehari-hari di Indonesia. Menyimpan faktor seratus
 * yang selalu nol hanya memindahkan kesempatan salah kali ke setiap tempat yang
 * membacanya — termasuk ke laporan pajak.
 */
const EXPONENT: Record<string, number> = {
  IDR: 0,
  USD: 2,
  EUR: 2,
  SGD: 2,
  JPY: 0,
};

export const DEFAULT_CURRENCY = 'IDR';

/** Batas atas yang masih selamat sebagai `number` di JavaScript. Di atas ini
 *  penjumlahan berhenti tepat tanpa memberi tahu siapa pun. */
const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER;

export function isSupportedCurrency(code: string): boolean {
  return code in EXPONENT;
}

export function exponentOf(currency: string): number {
  const exponent = EXPONENT[currency];
  if (exponent === undefined) throw new DomainError('invalid_input', 'mata uang tidak didukung');
  return exponent;
}

/**
 * Memeriksa jumlah yang datang dari luar.
 *
 * Menolak bukan bilangan bulat, bukan positif, dan yang melampaui batas aman.
 * Ketiganya dapat lolos validasi skema JSON dan tetap merusak pembukuan.
 */
export function assertAmount(amount: number): void {
  if (!Number.isInteger(amount)) throw new DomainError('invalid_input', 'jumlah harus bilangan bulat');
  if (amount <= 0) throw new DomainError('invalid_input', 'jumlah harus lebih dari nol');
  if (amount > MAX_SAFE_AMOUNT) throw new DomainError('invalid_input', 'jumlah melampaui batas');
}

/**
 * Menjumlahkan dengan pemeriksaan luapan.
 *
 * Deret transaksi yang panjang dapat melewati `Number.MAX_SAFE_INTEGER`, dan
 * JavaScript tidak melempar apa pun ketika itu terjadi — ia hanya mulai
 * menjawab salah.
 */
export function sumAmounts(amounts: readonly number[]): number {
  let total = 0;
  for (const amount of amounts) {
    total += amount;
    if (!Number.isSafeInteger(total)) throw new DomainError('invalid_input', 'jumlah melampaui batas');
  }
  return total;
}
