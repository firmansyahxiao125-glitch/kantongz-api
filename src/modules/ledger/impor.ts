import { DomainError } from '../../contracts/domain.js';
import type { ImportOutcome, ImportReport, TransactionKind } from '../../contracts/ledger.js';
import { DEFAULT_TIMEZONE, toDateString } from './periods.js';
import * as repo from './repository.js';
import { resolveShape, type LedgerDeps } from './service.js';

/**
 * Impor transaksi dari berkas.
 *
 * ── PRATINJAU LEBIH DULU, SELALU ────────────────────────────────────────
 *
 * `dryRun` mengerjakan SELURUH pemeriksaan dan tidak menulis apa pun. Berkas
 * seribu baris yang langsung masuk lalu ternyata salah kolom adalah seribu
 * baris yang harus dihapus satu per satu — dan pengguna tidak punya cara
 * membedakan mana yang barusan masuk dari mana yang sudah lama ada.
 *
 * ── DUPLIKAT ADALAH INTINYA, BUKAN TAMBAHAN ─────────────────────────────
 *
 * Orang mengimpor berkas yang sama dua kali. Mereka mengunduh mutasi bulan
 * ini, mengimpornya, lalu bulan depan mengunduh mutasi dua bulan dan
 * mengimpornya lagi. Impor tanpa pengenalan duplikat menggandakan separuh
 * pembukuan dan tidak memberi satu pun tanda.
 */

/** Batas baris per permintaan. */
export const MAX_ROWS = 500;

export interface ImportRow {
  accountId: string;
  counterAccountId?: string | undefined;
  categoryId?: string | undefined;
  kind: TransactionKind;
  amount: number;
  /** Epoch milidetik. */
  occurredAt: number;
  merchant?: string | undefined;
  note?: string | undefined;
}

/**
 * Kunci kesamaan.
 *
 * Dompet, jenis, jumlah, HARI LOKAL, dan merchant. Bukan jam: berkas yang
 * sama diunduh ulang sering membawa cap waktu yang berbeda beberapa detik,
 * dan dua baris yang berbeda tiga detik adalah baris yang sama.
 *
 * Merchant ikut karena tanpanya dua transaksi Rp 25.000 di warung berbeda
 * pada hari yang sama akan dianggap satu — dan yang kedua hilang diam-diam,
 * yang jauh lebih buruk daripada satu baris kembar yang terlihat.
 */
function kunci(
  accountId: string,
  kind: string,
  amount: number,
  hari: string,
  merchant: string | null,
): string {
  return [accountId, kind, String(amount), hari, (merchant ?? '').trim().toLowerCase()].join('|');
}

export async function importTransactions(
  deps: LedgerDeps,
  userId: string,
  rows: ImportRow[],
  options: { dryRun: boolean; timeZone?: string } = { dryRun: true },
): Promise<ImportReport> {
  if (rows.length === 0) {
    return { total: 0, imported: 0, duplicate: 0, failed: 0, dryRun: options.dryRun, results: [] };
  }
  if (rows.length > MAX_ROWS) {
    throw new DomainError('invalid_input', `maksimal ${String(MAX_ROWS)} baris sekali unggah`);
  }

  const timeZone = options.timeZone ?? DEFAULT_TIMEZONE;

  /*
   * Sidik jari yang sudah ada diambil SEKALI, untuk rentang berkas ini saja.
   * Satu kueri per baris akan berarti seribu perjalanan ke basis data untuk
   * satu unggahan; rentangnya dilebarkan sehari ke dua arah supaya transaksi
   * di tepi rentang — yang harinya bergeser oleh zona waktu — tetap terlihat.
   */
  const waktu = rows.map((r) => r.occurredAt);
  const dari = new Date(Math.min(...waktu) - 86_400_000);
  const sampai = new Date(Math.max(...waktu) + 86_400_000);

  const ada = new Set(
    (await repo.transactionFingerprints(deps.db, userId, dari, sampai)).map((t) =>
      kunci(t.accountId, t.kind, t.amount, toDateString(t.occurredAt, timeZone), t.merchant),
    ),
  );

  const results: ImportOutcome[] = [];
  let imported = 0;
  let duplicate = 0;
  let failed = 0;

  for (const [index, row] of rows.entries()) {
    const hari = toDateString(new Date(row.occurredAt), timeZone);
    const k = kunci(row.accountId, row.kind, row.amount, hari, row.merchant ?? null);

    /* Berkas yang memuat barisnya sendiri dua kali ikut tertangkap: kunci
       ditambahkan ke himpunan yang sama, jadi kembaran DI DALAM berkas
       diperlakukan persis seperti kembaran dengan yang sudah tersimpan. */
    if (ada.has(k)) {
      duplicate += 1;
      results.push({ index, status: 'duplicate', reason: 'sudah ada transaksi yang sama' });
      continue;
    }

    try {
      /* Divalidasi lewat `resolveShape` — fungsi yang SAMA dengan pencatatan
         manual. Impor yang menulis lewat jalur longgar adalah pintu belakang
         ke aturan yang dijaga ketat di pintu depan. */
      const shape = await resolveShape(deps, userId, row);

      if (!options.dryRun) {
        await repo.insertTransaction(deps.db, userId, {
          accountId: row.accountId,
          counterAccountId: shape.counterAccountId,
          categoryId: shape.categoryId,
          kind: row.kind,
          amount: row.amount,
          currency: shape.currency,
          occurredAt: new Date(row.occurredAt),
          note: row.note?.trim() ?? null,
          merchant: row.merchant?.trim() ?? null,
        });
      }

      ada.add(k);
      imported += 1;
      results.push({ index, status: 'imported', reason: null });
    } catch (error) {
      failed += 1;
      results.push({
        index,
        status: 'error',
        reason: error instanceof DomainError ? error.message : 'baris tidak dapat diimpor',
      });
    }
  }

  return { total: rows.length, imported, duplicate, failed, dryRun: options.dryRun, results };
}
