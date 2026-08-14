import type { Database } from '../../platform/db/client.js';
import type { Logger } from '../../platform/observability/logger.js';
import { runDueRecurring } from './recurring.js';

/**
 * Pekerja aturan berulang.
 *
 * Bentuknya sengaja meniru pekerja outbox sampai ke `setTimeout` berantainya:
 * dua pekerja yang tampak sama tetapi berperilaku beda pada kegagalan adalah
 * dua perilaku yang harus diingat terpisah, dan yang terlupa selalu yang
 * jarang gagal.
 *
 * Keamanan terhadap banyak instans datang dari `FOR UPDATE SKIP LOCKED` di
 * `lockRule` ditambah indeks unik `(rule_id, occurred_on)` — bukan dari
 * kesepakatan bahwa hanya satu proses yang boleh menjalankannya.
 */

export interface RecurringWorkerOptions {
  db: Database;
  logger: Logger;
  intervalMs: number;
}

export interface RecurringWorkerHandle {
  stop: () => void;
}

export function startRecurringWorker(options: RecurringWorkerOptions): RecurringWorkerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const loop = async (): Promise<void> => {
    if (stopped) return;

    try {
      const hasil = await runDueRecurring({ db: options.db }, { logger: options.logger });
      /* Dicatat hanya bila ADA yang terjadi. Putaran kosong tiap menit yang
         menulis satu baris log akan menenggelamkan segalanya yang lain. */
      if (hasil.posted > 0 || hasil.failed > 0) {
        options.logger.info(hasil, 'aturan berulang dijalankan');
      }
    } catch (error) {
      options.logger.error({ err: error }, 'putaran aturan berulang gagal');
    }

    if (!stopped) timer = setTimeout(() => void loop(), options.intervalMs);
  };

  timer = setTimeout(() => void loop(), options.intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
