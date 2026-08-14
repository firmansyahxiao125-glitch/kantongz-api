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
  /**
   * SMTP. Penyedia email BAWAAN.
   *
   * Mailpit di Docker Compose menyediakannya secara lokal tanpa akun apa pun,
   * dan Gmail menerimanya dengan sandi aplikasi. Tidak ada langganan yang perlu
   * dibayar untuk mengirim satu email verifikasi.
   *
   * Kosong berarti pekerja outbox berjalan dalam mode CATAT SAJA: pesan tetap
   * diantrekan dan tetap ditandai terkirim, tetapi tidak ada yang berangkat.
   */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

  /** Alamat pengirim. Dipakai SMTP maupun penyedia HTTP. */
  MAIL_FROM: z.string().email().default('noreply@kantongz.id'),

  /**
   * Penyedia email lewat HTTP. Adaptor OPSIONAL, tidak pernah bawaan.
   *
   * Diperiksa hanya setelah SMTP terbukti tidak dikonfigurasi.
   */
  MAIL_ENDPOINT: z.string().url().optional(),
  MAIL_API_KEY: z.string().min(1).optional(),

  /** Jeda antar putaran pekerja outbox. */
  OUTBOX_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),

  /**
   * Jeda antar putaran pekerja aturan berulang.
   *
   * Satu menit, bukan dua detik seperti outbox. Yang ditunggu di sini adalah
   * pergantian TANGGAL, jadi memeriksanya tiga puluh kali per menit hanya
   * menambah kueri tanpa menambah ketepatan. Batas bawahnya tetap rendah
   * supaya uji dapat memutarnya cepat.
   */
  RECURRING_INTERVAL_MS: z.coerce.number().int().min(200).max(3_600_000).default(60_000),

  /**
   * Model LOKAL lewat Ollama. Penyedia BAWAAN untuk M11 dan M13.
   *
   * Tanpa akun, tanpa biaya berulang, dan tanpa satu pun byte data keuangan
   * meninggalkan mesin pengguna — yang terakhir bukan efek samping, sebab
   * riwayat transaksi adalah data pribadi menurut UU PDP.
   *
   * Model bawaannya kecil dengan sengaja: `llama3.2:3b` muat di 4 GB RAM dan
   * berjalan di CPU. Ringkasan dua kalimat tidak menuntut lebih.
   */
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('llama3.2:3b'),
  /** Inferensi CPU bisa memakan puluhan detik. Permintaan yang menggantung
   *  lebih buruk daripada ringkasan bertemplat. */
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),

  /**
   * Penyedia awan. Adaptor OPSIONAL, tidak pernah bawaan.
   *
   * Diperiksa hanya setelah Ollama terbukti tidak ada. Ketiadaannya bukan
   * kegagalan, dan seluruh lapisan asisten tetap berjalan tanpanya.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5'),

  /**
   * Bahasa OCR untuk Snap-Struk. ROADMAP M6.
   *
   * `ind+eng`: struk Indonesia memakai istilah kedua bahasa dalam satu lembar —
   * "Total Bayar" dan "Cash" sering muncul bersebelahan.
   */
  OCR_LANGUAGES: z.string().min(2).default('ind+eng'),

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
  /* Alasan yang sama: endpoint tanpa kunci akan lolos boot lalu gagal pada
     email pertama — yang justru email verifikasi pengguna pertama. */
  .refine((c) => Boolean(c.MAIL_ENDPOINT) === Boolean(c.MAIL_API_KEY), {
    message: 'harus diisi berpasangan',
    path: ['MAIL_ENDPOINT'],
  })
  /* Sandi tanpa pengguna, atau sebaliknya, berarti AUTH yang tidak pernah
     berjalan pada server yang menuntutnya. */
  .refine((c) => Boolean(c.SMTP_USER) === Boolean(c.SMTP_PASSWORD), {
    message: 'harus diisi berpasangan',
    path: ['SMTP_USER'],
  });

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
