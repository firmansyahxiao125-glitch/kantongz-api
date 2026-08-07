import type { Database } from '../../platform/db/client.js';
import type { Logger } from '../../platform/observability/logger.js';
import { claimBatch, markFailed, markPublished, type OutboxMessage } from './index.js';
import { render, type Mailer } from './mailer.js';

/**
 * Pekerja outbox.
 *
 * Berjalan di dalam proses API, bukan sebagai layanan terpisah. Alasannya
 * praktis: satu proses lebih sedikit untuk disebarkan, dipantau, dan
 * dirahasiakan kuncinya — dan `FOR UPDATE SKIP LOCKED` sudah membuat sepuluh
 * instans API aman menjalankannya bersamaan.
 *
 * Kalau volumenya suatu hari menuntut penskalaan terpisah, `runOnce` di bawah
 * ini adalah seluruh yang perlu dipanggil dari entri baru.
 */

export interface WorkerOptions {
  db: Database;
  mailer: Mailer;
  logger: Logger;
  /** Jeda antar putaran. */
  intervalMs: number;
  /** Berapa pesan diambil sekaligus. */
  batchSize: number;
}

/**
 * Satu putaran: ambil, kirim, tandai.
 *
 * Seluruh putaran berjalan di dalam SATU transaksi supaya kunci baris bertahan
 * sampai penandaan selesai. Pengiriman yang berhasil lalu penandaan yang gagal
 * akan mengulang pengiriman — dan itulah persis yang dicegah `idempotencyKey`
 * di sisi penyedia.
 */
export async function runOnce(options: WorkerOptions): Promise<number> {
  const { db, mailer, logger, batchSize } = options;
  let sent = 0;

  await db.transaction(async (tx) => {
    const messages = await claimBatch(tx, batchSize);

    for (const message of messages) {
      try {
        await deliver(mailer, message);
        await markPublished(tx, message.id);
        sent += 1;

        /* Yang dicatat: topik dan id. TIDAK PERNAH alamat lengkap maupun
           kodenya — log adalah tempat kedua paling sering bocor setelah dump
           basis data. */
        logger.info({ outboxId: message.id, topic: message.topic }, 'pesan terkirim');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await markFailed(tx, message.id, reason);

        logger.warn(
          { outboxId: message.id, topic: message.topic, attempts: message.attempts + 1 },
          'pengiriman gagal',
        );
      }
    }
  });

  return sent;
}

async function deliver(mailer: Mailer, message: OutboxMessage): Promise<void> {
  const { subject, text } = render(message.topic, message.payload);

  await mailer.send({
    to: message.payload.to,
    subject,
    text,
    idempotencyKey: message.idempotencyKey,
  });
}

export interface WorkerHandle {
  stop: () => void;
}

/**
 * Menjalankan pekerja sampai dihentikan.
 *
 * `setTimeout` berantai, bukan `setInterval`. `setInterval` menumpuk putaran
 * ketika satu putaran lebih lama dari jedanya, dan penyedia email yang lambat
 * akan membuat proses membuka transaksi baru sebelum yang lama selesai.
 */
export function startWorker(options: WorkerOptions): WorkerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const loop = async (): Promise<void> => {
    if (stopped) return;

    try {
      await runOnce(options);
    } catch (error) {
      /* Kegagalan seluruh putaran — basis data tidak dapat dihubungi, misalnya.
         Dicatat lalu diabaikan: pekerja yang berhenti karena satu gangguan
         adalah pekerja yang harus dinyalakan manusia. */
      options.logger.error({ err: error }, 'putaran outbox gagal');
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
