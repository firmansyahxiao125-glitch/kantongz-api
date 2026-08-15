import type { KeyProvider } from '../../platform/crypto/index.js';
import type { Database } from '../../platform/db/client.js';
import type { Logger } from '../../platform/observability/logger.js';
import { pindaiPengingat } from '../reminder/service.js';
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
 *
 * ── MENGAPA PENGINGAT (G1) MENUMPANG PUTARAN INI ───────────────────────
 *
 * Bukan demi hemat proses — pekerjanya sudah ada dua dan yang ketiga tidak
 * mahal. Alasannya URUTAN.
 *
 * Pemindaian pengingat berjalan LEBIH DULU, sebelum aturan yang jatuh tempo
 * dicatat. Sesudah dicatat, `next_run_on` sudah melompat ke kejadian
 * berikutnya — bulan depan — dan aturan yang dibuat pengguna hari ini untuk
 * tagihan hari ini tidak akan pernah terlihat oleh pemindai yang berjalan
 * setelahnya. Dua pekerja terpisah dengan jeda masing-masing tidak dapat
 * menjanjikan urutan itu.
 *
 * Pemindaian tidak pernah menggagalkan pencatatan. Pengingat yang tidak
 * terkirim adalah email yang hilang; tagihan yang tidak tercatat adalah uang
 * yang salah.
 */

export interface RecurringWorkerOptions {
  db: Database;
  keys: KeyProvider;
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

    /* Pengingat lebih dulu, dan di dalam `try`-nya SENDIRI: pemindaian yang
       gagal — basis data lambat, kunci enkripsi salah — tidak boleh mencegah
       tagihan tercatat. Email yang hilang dapat dikirim putaran berikutnya;
       tagihan yang tidak tercatat adalah uang yang salah. */
    try {
      const pengingat = await pindaiPengingat(
        { db: options.db, keys: options.keys },
        new Date(),
      );
      if (pengingat.diantrekan > 0) {
        options.logger.info(pengingat, 'pengingat jatuh tempo diantrekan');
      }

      /* Baris yang tidak dapat didekripsi DISUARAKAN, tiap putaran.
         Melewatinya tanpa jejak menukar kegagalan berisik dengan kegagalan
         senyap: kunci yang salah konfigurasi akan terlihat persis seperti
         "tidak ada tagihan yang jatuh tempo". Yang dicatat hanya id
         penggunanya — tidak pernah cipherteksnya. */
      if (pengingat.takTerbaca.length > 0) {
        options.logger.warn(
          { pengguna: pengingat.takTerbaca, jumlah: pengingat.takTerbaca.length },
          'baris pengguna tidak dapat didekripsi — dilewati, pengingatnya tidak terkirim',
        );
      }
    } catch (error) {
      options.logger.error({ err: error }, 'pemindaian pengingat gagal');
    }

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
