import { z } from 'zod';

/**
 * Konfigurasi dari lingkungan, divalidasi sekali saat boot.
 *
 * Twelve-Factor III. Yang lebih penting: proses yang gagal boot karena satu
 * variabel hilang jauh lebih baik daripada proses yang berjalan lalu jatuh pada
 * permintaan pertama yang menyentuh variabel itu — kegagalan pertama terlihat
 * di CI, yang kedua terlihat oleh pengguna.
 *
 * Tidak ada nilai bawaan untuk rahasia. Bawaan hanya diberikan pada hal yang
 * aman bila salah: port, tingkat log, ukuran pool.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.string().url(),

  JWT_ISSUER: z.string().url(),
  JWT_AUDIENCE: z.string().min(1),
});

export type Config = Readonly<z.infer<typeof schema>>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    /* Nilai TIDAK ikut dicetak — variabel lingkungan memuat rahasia, dan pesan
       boot berakhir di agregator log. Yang dicetak hanya nama dan sebabnya. */
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join(String.fromCharCode(10));
    throw new Error(['Konfigurasi tidak valid:', detail].join(String.fromCharCode(10)));
  }

  return Object.freeze(parsed.data);
}

export function isProduction(config: Config): boolean {
  return config.NODE_ENV === 'production';
}
