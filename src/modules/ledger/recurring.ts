import { DomainError } from '../../contracts/domain.js';
import type { Cadence, RecurringRule } from '../../contracts/ledger.js';
import type { Logger } from '../../platform/observability/logger.js';
import type { RecurringRuleRow } from '../../platform/db/ledger.js';
import { DEFAULT_TIMEZONE, localNoon, toDateString } from './periods.js';
import * as repo from './repository.js';
import { MAX_CATCH_UP, anchorFrom, dueDates, nextDate, type Schedule } from './schedule.js';
import { resolveShape, type LedgerDeps } from './service.js';

/**
 * Aturan berulang.
 *
 * ── APA YANG DISIMPAN, DAN APA YANG TIDAK ───────────────────────────────
 *
 * Yang disimpan adalah ATURANNYA. Menuliskan dua belas transaksi di muka untuk
 * cicilan setahun berarti dua belas baris yang harus diperbaiki serentak saat
 * nominalnya berubah — dan yang bertanggal masa depan akan ikut terhitung di
 * saldo hari ini, membuat pengguna melihat uang yang belum keluar.
 *
 * ── MENGAPA INI MENCATAT SENDIRI, SEMENTARA PEMINDAI STRUK TIDAK ────────
 *
 * Struk menghasilkan angka TEBAKAN, jadi ia berhenti di formulir. Aturan
 * berulang berisi angka yang diketik pemiliknya sendiri; tidak ada yang perlu
 * diverifikasi, dan meminta konfirmasi tiap bulan atas nominal yang sudah
 * disetujui hanya memindahkan pekerjaan tanpa menambah kepastian.
 *
 * Yang tetap dijaga: setiap transaksi yang lahir dari sini dapat ditelusuri ke
 * aturannya lewat `recurring_runs`, dan aturannya dapat dijeda kapan pun.
 */

/** Berapa aturan yang diproses dalam satu putaran pekerja. */
const BATCH = 50;

/** Sejauh mana ke belakang tanggal mulai boleh diletakkan. */
export const MAX_BACKDATE_DAYS = 31;

export interface RecurringInput {
  name: string;
  accountId: string;
  counterAccountId?: string | undefined;
  categoryId?: string | undefined;
  kind: RecurringRule['kind'];
  amount: number;
  merchant?: string | undefined;
  note?: string | undefined;
  cadence: Cadence;
  interval: number;
  startsOn: string;
  endsOn?: string | undefined;
}

function scheduleOf(row: RecurringRuleRow): Schedule {
  return { cadence: row.cadence, interval: row.interval, anchorDay: row.anchorDay };
}

function toRule(row: RecurringRuleRow, postedCount: number): RecurringRule {
  return {
    id: row.id,
    name: row.name,
    accountId: row.accountId,
    counterAccountId: row.counterAccountId,
    categoryId: row.categoryId,
    kind: row.kind,
    amount: row.amount,
    currency: row.currency,
    merchant: row.merchant,
    note: row.note,
    cadence: row.cadence,
    interval: row.interval,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    nextRunOn: row.nextRunOn,
    lastRunOn: row.lastRunOn,
    paused: row.pausedAt !== null,
    postedCount,
  };
}

const TANGGAL = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, label: string): void {
  if (!TANGGAL.test(value)) throw new DomainError('invalid_input', `${label} harus YYYY-MM-DD`);
  /* Bentuk yang benar belum berarti tanggal yang ada. `2026-02-31` lolos
     ekspresi reguler di atas dan akan digulung diam-diam oleh `Date`. */
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const kembali = new Date(Date.UTC(y, m - 1, d));
  if (
    kembali.getUTCFullYear() !== y ||
    kembali.getUTCMonth() + 1 !== m ||
    kembali.getUTCDate() !== d
  ) {
    throw new DomainError('invalid_input', `${label} bukan tanggal yang ada`);
  }
}

/**
 * Memeriksa aturan sebelum disimpan.
 *
 * Bentuk transaksinya divalidasi lewat `resolveShape` — fungsi yang SAMA yang
 * dipakai pencatatan manual. Aturan yang lolos di sini karena itu pasti dapat
 * menulis transaksi nanti; menemukan dompet yang tidak ada pada putaran pekerja
 * pukul tiga pagi berarti kegagalan yang tidak dilihat siapa pun.
 */
async function validate(
  deps: LedgerDeps,
  userId: string,
  input: RecurringInput,
  today: string,
): Promise<{ counterAccountId: string | null; categoryId: string | null; currency: string }> {
  const name = input.name.trim();
  if (name.length === 0) throw new DomainError('invalid_input', 'aturan butuh nama');

  if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 366) {
    throw new DomainError('invalid_input', 'jarak pengulangan di luar batas');
  }

  assertDate(input.startsOn, 'tanggal mulai');
  if (input.endsOn) {
    assertDate(input.endsOn, 'tanggal berakhir');
    if (input.endsOn < input.startsOn) {
      throw new DomainError('invalid_input', 'tanggal berakhir mendahului tanggal mulai');
    }
  }

  /*
   * Mundur BOLEH, tapi tidak jauh.
   *
   * Aturan yang dibuat hari ini dengan tanggal mulai tahun lalu akan langsung
   * melahirkan ratusan transaksi yang tidak pernah diminta siapa pun. Sebulan
   * cukup untuk "sewa saya jatuh tanggal 1 dan hari ini tanggal 5", dan tidak
   * cukup untuk mengisi pembukuan dengan sejarah karangan.
   */
  const paling = toDateString(
    new Date(localNoon(today).getTime() - MAX_BACKDATE_DAYS * 86_400_000),
  );
  if (input.startsOn < paling) {
    throw new DomainError(
      'invalid_input',
      `tanggal mulai tidak boleh lebih dari ${String(MAX_BACKDATE_DAYS)} hari ke belakang`,
    );
  }

  return resolveShape(deps, userId, {
    accountId: input.accountId,
    counterAccountId: input.counterAccountId,
    categoryId: input.categoryId,
    kind: input.kind,
    amount: input.amount,
    /* Hanya untuk melewati pemeriksaan bentuk; tidak ada yang menyimpannya. */
    occurredAt: localNoon(input.startsOn).getTime(),
    note: input.note,
    merchant: input.merchant,
  });
}

export async function listRecurring(deps: LedgerDeps, userId: string): Promise<RecurringRule[]> {
  const rows = await repo.listRules(deps.db, userId);
  return Promise.all(
    rows.map(async (row) => toRule(row, await repo.countRuns(deps.db, row.id))),
  );
}

export async function createRecurring(
  deps: LedgerDeps,
  userId: string,
  input: RecurringInput,
  now = new Date(),
): Promise<RecurringRule> {
  const today = toDateString(now);
  const shape = await validate(deps, userId, input, today);

  const row = await repo.insertRule(deps.db, userId, {
    name: input.name.trim(),
    accountId: input.accountId,
    counterAccountId: shape.counterAccountId,
    categoryId: shape.categoryId,
    kind: input.kind,
    amount: input.amount,
    currency: shape.currency,
    merchant: input.merchant?.trim() ?? null,
    note: input.note?.trim() ?? null,
    cadence: input.cadence,
    interval: input.interval,
    anchorDay: anchorFrom(input.startsOn),
    startsOn: input.startsOn,
    endsOn: input.endsOn ?? null,
    nextRunOn: input.startsOn,
    lastRunOn: null,
    pausedAt: null,
  });

  return toRule(row, 0);
}

export async function updateRecurring(
  deps: LedgerDeps,
  userId: string,
  id: string,
  input: RecurringInput,
  now = new Date(),
): Promise<RecurringRule> {
  const existing = await repo.findRule(deps.db, userId, id);
  if (!existing) throw new DomainError('not_found', 'aturan tidak ditemukan');

  const today = toDateString(now);
  const shape = await validate(deps, userId, input, today);

  /*
   * Yang sudah tercatat TIDAK disentuh, dan `nextRunOn` tidak dimundurkan.
   *
   * Mengubah jadwal lalu mengembalikan tanggal jalan ke tanggal mulai akan
   * membuat pekerja mengejar ulang kejadian yang sudah lewat. Indeks unik
   * `(rule_id, occurred_on)` akan menolak yang benar-benar kembar, tetapi
   * irama baru menghasilkan TANGGAL BARU yang tidak kembar — dan bulan yang
   * sudah dibayar akan tercatat dua kali dengan tanggal berbeda.
   */
  const berikut =
    input.startsOn > existing.nextRunOn ? input.startsOn : existing.nextRunOn;

  const row = await repo.updateRule(deps.db, userId, id, {
    name: input.name.trim(),
    accountId: input.accountId,
    counterAccountId: shape.counterAccountId,
    categoryId: shape.categoryId,
    kind: input.kind,
    amount: input.amount,
    currency: shape.currency,
    merchant: input.merchant?.trim() ?? null,
    note: input.note?.trim() ?? null,
    cadence: input.cadence,
    interval: input.interval,
    anchorDay: anchorFrom(input.startsOn),
    startsOn: input.startsOn,
    endsOn: input.endsOn ?? null,
    nextRunOn: berikut,
  });

  if (!row) throw new DomainError('not_found', 'aturan tidak ditemukan');
  return toRule(row, await repo.countRuns(deps.db, id));
}

/**
 * Menjeda atau melanjutkan.
 *
 * Melanjutkan MELOMPATI yang terlewat: `nextRunOn` dimajukan ke kejadian
 * pertama yang belum lewat. Aturan yang dijeda tiga bulan lalu dilanjutkan
 * seharusnya menagih bulan depan, bukan menagih tiga bulan sekaligus — orang
 * menjeda justru supaya tagihannya tidak terjadi.
 */
export async function setRecurringPaused(
  deps: LedgerDeps,
  userId: string,
  id: string,
  paused: boolean,
  now = new Date(),
): Promise<RecurringRule> {
  const existing = await repo.findRule(deps.db, userId, id);
  if (!existing) throw new DomainError('not_found', 'aturan tidak ditemukan');

  const today = toDateString(now);
  const patch: Partial<RecurringRuleRow> = { pausedAt: paused ? now : null };

  if (!paused) {
    let pada = existing.nextRunOn;
    let langkah = 0;
    while (pada <= today && langkah < 4000) {
      const maju = nextDate(pada, scheduleOf(existing));
      if (maju <= pada) break;
      pada = maju;
      langkah += 1;
    }
    patch.nextRunOn = pada;
  }

  const row = await repo.updateRule(deps.db, userId, id, patch);
  if (!row) throw new DomainError('not_found', 'aturan tidak ditemukan');
  return toRule(row, await repo.countRuns(deps.db, id));
}

/**
 * Menghapus aturan. Transaksi yang SUDAH lahir darinya tetap tinggal.
 *
 * `recurring_runs` ikut terhapus lewat cascade, jadi jejak "dari aturan mana"
 * hilang — tetapi uangnya tidak. Menghapus transaksi yang sudah terjadi karena
 * jadwalnya dibatalkan akan mengubah saldo bulan-bulan yang sudah ditutup.
 */
export async function deleteRecurring(
  deps: LedgerDeps,
  userId: string,
  id: string,
): Promise<void> {
  const removed = await repo.deleteRule(deps.db, userId, id);
  if (!removed) throw new DomainError('not_found', 'aturan tidak ditemukan');
}

export interface RunSummary {
  /** Berapa transaksi yang lahir. */
  posted: number;
  /** Berapa aturan yang gagal diproses seluruhnya. */
  failed: number;
}

/**
 * Satu putaran: catat semua yang jatuh tempo.
 *
 * SETIAP aturan berjalan di transaksi basis datanya SENDIRI. Satu angkatan
 * dalam satu transaksi berarti satu aturan yang gagal — dompetnya diarsipkan,
 * kategorinya lenyap — membatalkan penulisan aturan milik pengguna lain yang
 * tidak berhubungan sama sekali.
 */
export async function runDueRecurring(
  deps: LedgerDeps,
  options: { now?: Date; timeZone?: string; logger?: Logger } = {},
): Promise<RunSummary> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? DEFAULT_TIMEZONE;
  const today = toDateString(now, timeZone);

  const ids = await repo.dueRuleIds(deps.db, today, BATCH);
  let posted = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      posted += await runOneRule(deps, id, today, timeZone);
    } catch (error) {
      failed += 1;
      options.logger?.warn({ ruleId: id, err: error }, 'aturan berulang gagal dijalankan');
    }
  }

  return { posted, failed };
}

async function runOneRule(
  deps: LedgerDeps,
  id: string,
  today: string,
  timeZone: string,
): Promise<number> {
  let ditulis = 0;

  await deps.db.transaction(async (tx) => {
    const rule = await repo.lockRule(tx, id, today);
    /* Kosong berarti putaran lain sedang memegangnya, atau sudah
       menuntaskannya di antara pemilihan id dan penguncian ini. Keduanya
       bukan kegagalan. */
    if (!rule) return;

    const jadwal = scheduleOf(rule);
    const tanggal = dueDates(rule.nextRunOn, today, jadwal, rule.endsOn, MAX_CATCH_UP);
    if (tanggal.length === 0) return;

    for (const pada of tanggal) {
      const trx = await repo.insertTransaction(tx, rule.userId, {
        accountId: rule.accountId,
        counterAccountId: rule.counterAccountId,
        categoryId: rule.categoryId,
        kind: rule.kind,
        amount: rule.amount,
        currency: rule.currency,
        occurredAt: localNoon(pada, timeZone),
        note: rule.note,
        merchant: rule.merchant,
      });

      const tercatat = await repo.insertRun(tx, rule.id, pada, trx.id);
      /* Melempar, dan itu benar. Transaksi uangnya baru saja ditulis di baris
         atas; membiarkannya berarti satu tagihan tercatat dua kali. Lemparan
         ini membatalkan SELURUH transaksi basis data, termasuk penulisan itu. */
      if (!tercatat) {
        throw new Error(`kejadian ${pada} pada aturan ${rule.id} sudah pernah tercatat`);
      }

      ditulis += 1;
    }

    const terakhir = tanggal[tanggal.length - 1] as string;
    const berikut = nextDate(terakhir, jadwal);

    await repo.updateRule(tx, rule.userId, rule.id, {
      lastRunOn: terakhir,
      nextRunOn: berikut,
    });
  });

  return ditulis;
}
