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
/**
 * PEM di dalam variabel lingkungan.
 *
 * Orkestrator, berkas `.env`, dan manajer rahasia menyampaikan baris baru dengan
 * cara yang berbeda-beda; sebagian meneruskan `\n` harfiah. Normalisasi di satu
 * tempat mencegah kegagalan impor kunci yang pesannya tidak menyebut sebabnya.
 */
const pem = z
  .string()
  .min(1)
  .transform((value) => value.replaceAll(String.raw`\n`, String.fromCharCode(10)).trim())
  .refine((value) => value.startsWith('-----BEGIN'), 'bukan PEM');

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

  /**
   * Kunci penandatangan access token, PKCS#8 dan SPKI. §4.3.
   *
   * Membangkitkan pasangan kunci saat boot akan membuat setiap instans
   * menandatangani dengan `kid` yang berlainan, dan penyebaran bergulir akan
   * membatalkan token yang baru saja diterbitkan instans tetangganya.
   */
  JWT_PRIVATE_KEY: pem,
  JWT_PUBLIC_KEY: pem,

  /** Pasangan sebelumnya, hidup selama masa tumpang tindih rotasi. §4.3 —
   *  token lama harus tetap terverifikasi sampai kedaluwarsa. */
  JWT_PREVIOUS_PRIVATE_KEY: pem.optional(),
  JWT_PREVIOUS_PUBLIC_KEY: pem.optional(),

  /** Rahasia induk untuk HMAC pencarian, enkripsi kolom, dan tiket hantu. §7.
   *  Di produksi berkas ini hanya memegang penunjuk KMS-nya. */
  MASTER_KEY: z.string().min(32),
  /** Naik satu setiap rotasi kunci HMAC. Baris lama tetap terbaca lewat
   *  `hmac_key_version` miliknya sendiri. §7.1 */
  HMAC_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  /**
   * Penyedia email. §7.
   *
   * Ketiganya opsional bersama-sama: tanpa mereka pekerja outbox berjalan dalam
   * mode CATAT SAJA — pesan tetap diantrekan dan tetap ditandai terkirim, tetapi
   * tidak ada yang berangkat. Itu yang benar untuk pengembangan, dan `/readyz`
   * yang menunjukkan antrean menumpuk kalau seseorang lupa mengisinya di
   * produksi.
   */
  MAIL_ENDPOINT: z.string().url().optional(),
  MAIL_API_KEY: z.string().min(1).optional(),
  MAIL_FROM: z.string().email().optional(),

  /** Jeda antar putaran pekerja outbox. */
  OUTBOX_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),

  /**
   * Asal yang boleh memanggil dari peramban, dipisahkan koma.
   *
   * DAFTAR IZIN, bukan `*`. Aplikasi web memanggil backend langsung dari
   * peramban dengan Bearer token; `*` berarti halaman mana pun di internet
   * dapat membaca jawaban itu bila ia berhasil memperoleh tokennya.
   *
   * Kosong berarti TIDAK ADA asal peramban yang diizinkan — yang benar untuk
   * penyebaran khusus-mobile, karena `fetch` native tidak tunduk pada CORS.
   */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
});

/* Setengah pasangan kunci lama lebih berbahaya daripada tidak ada sama sekali:
   ia lolos boot lalu gagal pada verifikasi pertama yang membutuhkannya. */
const validated = schema
  .refine((c) => Boolean(c.JWT_PREVIOUS_PRIVATE_KEY) === Boolean(c.JWT_PREVIOUS_PUBLIC_KEY), {
    message: 'harus diisi berpasangan',
    path: ['JWT_PREVIOUS_PRIVATE_KEY'],
  })
  /* Alasan yang sama: endpoint tanpa kunci, atau kunci tanpa pengirim, akan
     lolos boot lalu gagal pada email pertama — yang justru email verifikasi
     pengguna pertama. */
  .refine(
    (c) =>
      [c.MAIL_ENDPOINT, c.MAIL_API_KEY, c.MAIL_FROM].filter(Boolean).length % 3 === 0,
    { message: 'harus diisi lengkap atau dikosongkan seluruhnya', path: ['MAIL_ENDPOINT'] },
  );

export type Config = Readonly<z.infer<typeof validated>>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = validated.safeParse(source);

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
