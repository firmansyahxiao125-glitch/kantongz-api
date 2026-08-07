import { pingDatabase, type DbHandle } from '../../platform/db/client.js';
import { pingRedis, type RedisHandle } from '../../platform/redis/client.js';
import { stats as outboxStats } from '../../modules/outbox/index.js';
import type { App } from '../types.js';
import { success } from '../envelope.js';

/**
 * Tiga endpoint, tiga pertanyaan berbeda. Menggabungkannya adalah kesalahan
 * yang mahal di Kubernetes.
 *
 * `/livez`   — apakah proses ini harus dibunuh dan dijalankan ulang?
 *              TIDAK PERNAH menyentuh dependensi. Basis data yang jatuh bukan
 *              alasan membunuh proses; me-restart-nya tidak memperbaiki apa pun
 *              dan justru menghapus koneksi yang sudah hangat.
 *
 * `/readyz`  — apakah proses ini boleh menerima lalu lintas sekarang?
 *              Menyentuh dependensi. Yang tidak siap dikeluarkan dari
 *              penyeimbang beban, bukan dibunuh.
 *
 * `/healthz` — ringkasan untuk manusia dan pemantauan.
 */
export interface HealthDeps {
  db: DbHandle;
  redis: RedisHandle;
  startedAt: number;
  version: string;
}

type Check = { name: string; ok: boolean; error?: string };

async function runCheck(name: string, fn: () => Promise<void>): Promise<Check> {
  try {
    await fn();
    return { name, ok: true };
  } catch (error) {
    /* Pesan aslinya bisa memuat host dan kredensial; hanya jenisnya yang keluar. */
    return { name, ok: false, error: error instanceof Error ? error.name : 'unknown' };
  }
}

export function registerHealthRoutes(app: App, deps: HealthDeps): void {
  app.get('/livez', (request, reply) => {
    void reply.send(success({ status: 'alive' }, request.requestId));
  });

  app.get('/readyz', async (request, reply) => {
    const checks = await Promise.all([
      runCheck('postgres', () => pingDatabase(deps.db)),
      runCheck('redis', () => pingRedis(deps.redis)),
    ]);

    const ready = checks.every((c) => c.ok);
    void reply
      .status(ready ? 200 : 503)
      .send(success({ status: ready ? 'ready' : 'not_ready', checks }, request.requestId));
  });

  app.get('/healthz', async (request, reply) => {
    const checks = await Promise.all([
      runCheck('postgres', () => pingDatabase(deps.db)),
      runCheck('redis', () => pingRedis(deps.redis)),
    ]);

    /* Kedalaman antrean dilaporkan di sini, bukan sebagai `check` yang bisa
       gagal: outbox yang menumpuk BUKAN alasan mengeluarkan instans dari
       penyeimbang beban — instans lain punya antrean yang sama persis. Ia
       alasan membangunkan manusia, dan itu tugas pemantauan. */
    const queue = await outboxStats(deps.db.db).catch(() => null);

    void reply.send(
      success(
        {
          status: checks.every((c) => c.ok) ? 'healthy' : 'degraded',
          version: deps.version,
          uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
          checks,
          outbox: queue,
        },
        request.requestId,
      ),
    );
  });
}
