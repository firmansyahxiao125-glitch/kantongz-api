import { STATUS_FOR, type ErrorCode } from '../contracts/domain.js';
import type { App } from './types.js';

/**
 * Dokumen OpenAPI 3.1. M3_SPEC §17.
 *
 * Ditulis tangan, bukan dibangkitkan dari skema Fastify. Rute di sini
 * memvalidasi dengan zod di dalam penangan justru supaya pesan galatnya tidak
 * membocorkan bentuk API (§18), jadi tidak ada skema Fastify yang bisa
 * dibangkitkan darinya.
 *
 * Yang menjaga dokumen ini tidak membusuk adalah uji di
 * `__tests__/openapi.test.ts`: setiap rute yang terdaftar di aplikasi WAJIB ada
 * di sini, dan sebaliknya. Dokumentasi yang tidak ditegakkan uji akan
 * menyimpang dalam hitungan minggu.
 */

const VERSION = '1.0.0';

interface Ref {
  $ref: string;
}

function ref(name: string): Ref {
  return { $ref: `#/components/schemas/${name}` };
}

/** Amplop sukses §18. Setiap respons 2xx memakai bentuk ini. */
function envelope(dataSchema: unknown): Record<string, unknown> {
  return {
    type: 'object',
    required: ['data', 'meta'],
    additionalProperties: false,
    properties: { data: dataSchema, meta: ref('Meta') },
  };
}

function json(schema: unknown): Record<string, unknown> {
  return { 'application/json': { schema } };
}

/**
 * Respons galat yang mungkin untuk sebuah rute.
 *
 * Diturunkan dari `STATUS_FOR` supaya penambahan kode galat tidak dapat lolos
 * tanpa dokumentasinya ikut berubah.
 */
function errors(...codes: ErrorCode[]): Record<string, unknown> {
  const byStatus = new Map<number, ErrorCode[]>();

  for (const code of codes) {
    const status = STATUS_FOR[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }

  return Object.fromEntries(
    [...byStatus].map(([status, group]) => [
      String(status),
      {
        description: group.join(', '),
        content: json(ref('ErrorEnvelope')),
      },
    ]),
  );
}

const DEVICE = ref('DeviceInfo');

/** Rute yang menuntut Bearer, dinyatakan sekali. */
const SECURED = [{ bearerAuth: [] }];

export function buildOpenApiDocument(baseUrl: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',

    info: {
      title: 'KANTONGZ API',
      version: VERSION,
      description:
        'Backend KANTONGZ. Seluruh jumlah uang adalah BILANGAN BULAT dalam satuan terkecil mata uangnya yang beredar — untuk IDR itu rupiah utuh, bukan sen. Tidak ada pecahan yang menyeberangi batas HTTP.',
      license: { name: 'UNLICENSED', identifier: 'LicenseRef-Proprietary' },
    },

    servers: [{ url: baseUrl }],

    tags: [
      { name: 'kesehatan', description: 'Pemeriksaan kesiapan dan kelangsungan proses' },
      { name: 'autentikasi', description: 'Pendaftaran, masuk, rotasi token, pemulihan sandi' },
      { name: 'dompet', description: 'Dompet dan kategori' },
      { name: 'transaksi', description: 'Pencatatan pemasukan, pengeluaran, dan transfer' },
      { name: 'rencana', description: 'Anggaran dan tujuan menabung' },
      { name: 'analitik', description: 'Arus kas dan ringkasan dasbor' },
      { name: 'wawasan', description: 'Anomali, langganan berulang, proyeksi arus kas' },
      { name: 'asisten', description: 'Ringkasan naratif dan simulasi what-if' },
      { name: 'struk', description: 'Snap-Struk — foto struk menjadi rancangan transaksi' },
    ],

    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Access token RS256, umur 10 menit. Klaimnya hanya `sub`, `sid`, `did`, `rol` — tidak ada data pribadi. Kunci publik ada di /.well-known/jwks.json.',
        },
      },

      schemas: {
        Meta: {
          type: 'object',
          required: ['requestId'],
          additionalProperties: false,
          properties: {
            requestId: {
              type: 'string',
              description: 'Dikembalikan juga sebagai header `x-request-id`, dan nilainya sama.',
            },
          },
        },

        ErrorEnvelope: {
          type: 'object',
          required: ['error', 'meta'],
          additionalProperties: false,
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'details', 'retryAfter'],
              additionalProperties: false,
              properties: {
                code: { type: 'string', enum: Object.keys(STATUS_FOR) },
                message: {
                  type: 'string',
                  description:
                    'Untuk log, BUKAN untuk ditampilkan. Klien menerjemahkan `code` sendiri.',
                },
                details: { type: ['object', 'null'] },
                retryAfter: {
                  type: ['integer', 'null'],
                  description: 'Detik. Hadir bersama `rate_limited`, sama dengan header Retry-After.',
                },
              },
            },
            meta: ref('Meta'),
          },
        },

        DeviceInfo: {
          type: 'object',
          required: ['deviceId', 'platform'],
          additionalProperties: false,
          description:
            'Identitas perangkat. Keluarga token diikat kepadanya (§15): token yang muncul dari deviceId berbeda mencabut seluruh keluarganya.',
          properties: {
            deviceId: { type: 'string', minLength: 8, maxLength: 128 },
            platform: { type: 'string', enum: ['ios', 'android', 'web'] },
            model: { type: 'string', maxLength: 120 },
            appVersion: { type: 'string', maxLength: 40 },
          },
        },

        User: {
          type: 'object',
          required: ['id', 'email', 'fullName'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            email: { type: 'string', format: 'email' },
            fullName: { type: 'string' },
          },
        },

        /* Sengaja TIDAK memuat token, deviceHash, maupun alamat IP: yang
           ditampilkan hanya yang dibutuhkan pemiliknya untuk menjawab
           "apakah ini aku?" lalu menindaknya. */
        ActiveSession: {
          type: 'object',
          required: [
            'id', 'platform', 'model', 'appVersion',
            'createdAt', 'lastSeenAt', 'absoluteExpiresAt', 'current',
          ],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            platform: { type: 'string' },
            model: { type: 'string', nullable: true },
            appVersion: { type: 'string', nullable: true },
            createdAt: { type: 'integer', description: 'epoch ms' },
            lastSeenAt: { type: 'integer', description: 'epoch ms' },
            absoluteExpiresAt: { type: 'integer', description: 'epoch ms' },
            current: {
              type: 'boolean',
              description: 'sesi yang sedang dipakai permintaan ini',
            },
          },
        },

        AuthTokens: {
          type: 'object',
          required: ['accessToken', 'refreshToken', 'accessTokenExpiresAt'],
          additionalProperties: false,
          properties: {
            accessToken: { type: 'string' },
            refreshToken: {
              type: 'string',
              description: 'Buram, bukan JWT. Disimpan server sebagai SHA-256.',
            },
            accessTokenExpiresAt: {
              type: 'integer',
              description: 'Epoch milidetik, ABSOLUT — bukan durasi.',
            },
          },
        },

        Session: {
          type: 'object',
          required: ['user', 'tokens'],
          additionalProperties: false,
          properties: { user: ref('User'), tokens: ref('AuthTokens') },
        },

        PendingVerification: {
          type: 'object',
          required: ['ticket', 'maskedEmail', 'codeLength'],
          additionalProperties: false,
          description: 'Kodenya TIDAK PERNAH ikut — ia berangkat lewat outbox ke email.',
          properties: {
            ticket: { type: 'string' },
            maskedEmail: { type: 'string' },
            codeLength: { type: 'integer' },
          },
        },

        WalletAccount: {
          type: 'object',
          required: ['id', 'name', 'kind', 'currency', 'openingBalance', 'balance', 'color', 'archived'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string', maxLength: 80 },
            kind: { type: 'string', enum: ['cash', 'bank', 'ewallet', 'card', 'investment'] },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            openingBalance: { type: 'integer' },
            balance: {
              type: 'integer',
              description: 'Dihitung dari buku, tidak pernah disimpan sebagai kolom.',
            },
            color: { type: ['string', 'null'] },
            archived: { type: 'boolean' },
          },
        },

        Category: {
          type: 'object',
          required: ['id', 'name', 'kind', 'icon', 'color', 'system'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string', maxLength: 60 },
            kind: { type: 'string', enum: ['income', 'expense'] },
            icon: { type: 'string' },
            color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
            system: {
              type: 'boolean',
              description: 'Bawaan sistem, dibagi seluruh pengguna dan tidak dapat diubah.',
            },
          },
        },

        Transaction: {
          type: 'object',
          required: [
            'id',
            'accountId',
            'counterAccountId',
            'categoryId',
            'kind',
            'amount',
            'currency',
            'occurredAt',
            'note',
            'merchant',
          ],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            accountId: { type: 'string' },
            counterAccountId: {
              type: ['string', 'null'],
              description: 'Hanya untuk `transfer`. Transfer adalah SATU baris dengan dua dompet.',
            },
            categoryId: { type: ['string', 'null'] },
            kind: { type: 'string', enum: ['income', 'expense', 'transfer'] },
            amount: {
              type: 'integer',
              minimum: 1,
              description: 'Selalu POSITIF. Arah ditentukan `kind`, bukan tanda bilangan.',
            },
            currency: { type: 'string' },
            occurredAt: { type: 'integer', description: 'Epoch milidetik.' },
            note: { type: ['string', 'null'] },
            merchant: { type: ['string', 'null'] },
          },
        },

        TransactionInput: {
          type: 'object',
          required: ['accountId', 'kind', 'amount', 'occurredAt'],
          additionalProperties: false,
          properties: {
            accountId: { type: 'string' },
            counterAccountId: { type: 'string' },
            categoryId: { type: 'string' },
            kind: { type: 'string', enum: ['income', 'expense', 'transfer'] },
            amount: { type: 'integer', minimum: 1 },
            occurredAt: { type: 'integer' },
            note: { type: 'string', maxLength: 280 },
            merchant: { type: 'string', maxLength: 120 },
          },
        },

        TransactionPage: {
          type: 'object',
          required: ['items', 'nextCursor'],
          additionalProperties: false,
          properties: {
            items: { type: 'array', items: ref('Transaction') },
            nextCursor: {
              type: ['string', 'null'],
              description:
                'Membawa KEDUA kolom pengurutan. Kursor yang hanya membawa id memotong daftar di tempat yang salah begitu transaksi dicatat mundur.',
            },
          },
        },

        Budget: {
          type: 'object',
          required: ['id', 'categoryId', 'period', 'amount', 'currency', 'startsOn', 'spent'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            categoryId: { type: 'string' },
            period: { type: 'string', enum: ['weekly', 'monthly', 'yearly'] },
            amount: { type: 'integer', minimum: 1 },
            currency: { type: 'string' },
            startsOn: { type: 'string', format: 'date' },
            spent: { type: 'integer', description: 'Dihitung dari transaksi periode berjalan.' },
          },
        },

        Goal: {
          type: 'object',
          required: [
            'id',
            'name',
            'targetAmount',
            'savedAmount',
            'currency',
            'targetDate',
            'color',
            'achieved',
          ],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string', maxLength: 80 },
            targetAmount: { type: 'integer', minimum: 1 },
            savedAmount: { type: 'integer', minimum: 0 },
            currency: { type: 'string' },
            targetDate: { type: ['string', 'null'], format: 'date' },
            color: { type: ['string', 'null'] },
            achieved: { type: 'boolean' },
          },
        },

        CashflowPoint: {
          type: 'object',
          required: ['bucket', 'income', 'expense'],
          additionalProperties: false,
          properties: {
            bucket: { type: 'string', description: 'YYYY-MM-DD harian, YYYY-MM bulanan.' },
            income: { type: 'integer' },
            expense: { type: 'integer' },
          },
        },

        CategoryBreakdown: {
          type: 'object',
          required: ['categoryId', 'categoryName', 'color', 'total'],
          additionalProperties: false,
          properties: {
            categoryId: { type: ['string', 'null'] },
            categoryName: { type: 'string' },
            color: { type: 'string' },
            total: { type: 'integer' },
          },
        },

        DashboardSummary: {
          type: 'object',
          required: [
            'currency',
            'netWorth',
            'monthIncome',
            'monthExpense',
            'expenseDelta',
            'accounts',
            'recent',
            'cashflow',
            'topCategories',
            'budgets',
            'goals',
          ],
          additionalProperties: false,
          properties: {
            currency: { type: 'string' },
            netWorth: { type: 'integer' },
            monthIncome: { type: 'integer' },
            monthExpense: { type: 'integer' },
            expenseDelta: {
              type: ['integer', 'null'],
              description: '`null` berarti belum ada bulan pembanding — BUKAN "tidak berubah".',
            },
            accounts: { type: 'array', items: ref('WalletAccount') },
            recent: { type: 'array', items: ref('Transaction') },
            cashflow: { type: 'array', items: ref('CashflowPoint') },
            topCategories: { type: 'array', items: ref('CategoryBreakdown') },
            budgets: { type: 'array', items: ref('Budget') },
            goals: { type: 'array', items: ref('Goal') },
          },
        },

        Insight: {
          type: 'object',
          required: [
            'id',
            'kind',
            'severity',
            'title',
            'body',
            'reason',
            'amount',
            'transactionId',
            'categoryId',
          ],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            kind: {
              type: 'string',
              enum: [
                'anomaly',
                'ghost_subscription',
                'budget_risk',
                'cashflow_risk',
                'weekly_summary',
              ],
            },
            severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
            title: { type: 'string' },
            body: { type: 'string', description: 'Boleh ditampilkan apa adanya.' },
            reason: {
              type: 'string',
              description:
                'MENGAPA wawasan ini muncul, dalam angka. Wawasan tanpa ini adalah tebakan yang menyamar sebagai analisis.',
            },
            amount: { type: ['integer', 'null'] },
            transactionId: { type: ['string', 'null'] },
            categoryId: { type: ['string', 'null'] },
          },
        },

        CashflowProjection: {
          type: 'object',
          required: [
            'startingBalance',
            'dailyNet',
            'points',
            'basisDays',
            'reliable',
            'daysUntilEmpty',
          ],
          additionalProperties: false,
          properties: {
            startingBalance: { type: 'integer' },
            dailyNet: { type: 'integer' },
            points: {
              type: 'array',
              items: {
                type: 'object',
                required: ['horizonDays', 'expected', 'low', 'high'],
                additionalProperties: false,
                properties: {
                  horizonDays: { type: 'integer' },
                  expected: { type: 'integer' },
                  low: { type: 'integer' },
                  high: { type: 'integer' },
                },
              },
            },
            basisDays: { type: 'integer' },
            reliable: {
              type: 'boolean',
              description:
                'false berarti datanya belum cukup — bukan proyeksi dengan pita selebar samudra yang tetap ditampilkan.',
            },
            daysUntilEmpty: {
              type: ['integer', 'null'],
              description: 'null berarti saldo tidak sedang menuju nol.',
            },
          },
        },

        RecurringCharge: {
          type: 'object',
          required: [
            'merchant',
            'amount',
            'intervalDays',
            'occurrences',
            'lastChargedAt',
            'monthlyCost',
            'dormant',
          ],
          additionalProperties: false,
          properties: {
            merchant: { type: 'string' },
            amount: { type: 'integer' },
            intervalDays: { type: 'integer' },
            occurrences: { type: 'integer' },
            lastChargedAt: { type: 'integer' },
            monthlyCost: { type: 'integer' },
            dormant: { type: 'boolean' },
          },
        },

        InsightDigest: {
          type: 'object',
          required: ['generatedAt', 'insights', 'projection', 'recurring'],
          additionalProperties: false,
          properties: {
            generatedAt: { type: 'integer' },
            insights: { type: 'array', items: ref('Insight') },
            projection: ref('CashflowProjection'),
            recurring: { type: 'array', items: ref('RecurringCharge') },
          },
        },

        CategorySuggestion: {
          type: 'object',
          required: ['transactionId', 'categoryId', 'categoryName', 'reason'],
          additionalProperties: false,
          properties: {
            transactionId: { type: 'string' },
            categoryId: { type: 'string' },
            categoryName: { type: 'string' },
            reason: { type: 'string' },
          },
        },

        PeriodSummary: {
          type: 'object',
          required: [
            'from',
            'to',
            'income',
            'expense',
            'net',
            'topCategories',
            'narrative',
            'narrativeSource',
            'insights',
          ],
          additionalProperties: false,
          properties: {
            from: { type: 'integer' },
            to: { type: 'integer' },
            income: { type: 'integer' },
            expense: { type: 'integer' },
            net: { type: 'integer' },
            topCategories: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'total'],
                additionalProperties: false,
                properties: { name: { type: 'string' }, total: { type: 'integer' } },
              },
            },
            narrative: { type: 'string' },
            narrativeSource: {
              type: 'string',
              enum: ['model', 'template'],
              description:
                'Dinyatakan terbuka. Ringkasan bertemplat yang menyamar sebagai analisis merusak kepercayaan pada seluruh angka di sekitarnya.',
            },
            insights: { type: 'array', items: ref('Insight') },
          },
        },

        Simulation: {
          type: 'object',
          required: [
            'monthlyCommitment',
            'months',
            'currentMonthlySurplus',
            'projectedMonthlySurplus',
            'balanceAtEnd',
            'monthsUntilEmpty',
            'verdict',
            'reason',
            'basisDays',
            'reliable',
          ],
          additionalProperties: false,
          description:
            'Aritmetika murni dari data pengguna sendiri. Tidak ada model yang terlibat, jadi jawabannya dapat diperiksa ulang dengan kalkulator.',
          properties: {
            monthlyCommitment: { type: 'integer' },
            months: { type: 'integer' },
            currentMonthlySurplus: { type: 'integer' },
            projectedMonthlySurplus: { type: 'integer' },
            balanceAtEnd: { type: 'integer' },
            monthsUntilEmpty: { type: ['integer', 'null'] },
            verdict: { type: 'string', enum: ['aman', 'ketat', 'tidak_aman'] },
            reason: { type: 'string' },
            basisDays: { type: 'integer' },
            reliable: { type: 'boolean' },
          },
        },

        ReceiptDraft: {
          type: 'object',
          required: ['merchant', 'total', 'occurredAt', 'confidence', 'totalLine'],
          additionalProperties: false,
          description:
            'RANCANGAN, bukan transaksi. Pengguna selalu mengonfirmasi sebelum apa pun tersimpan — struk yang terbaca separuh menghasilkan angka yang terlihat sah.',
          properties: {
            merchant: { type: ['string', 'null'] },
            total: {
              type: ['integer', 'null'],
              description: 'Rupiah UTUH. null berarti tidak ditemukan dengan yakin.',
            },
            occurredAt: { type: ['integer', 'null'], description: 'Epoch milidetik.' },
            confidence: {
              type: 'string',
              enum: ['tinggi', 'sedang', 'rendah'],
              description:
                'Dinyatakan terbuka. Pengguna yang tidak diberi tahu keraguannya akan menyimpan angkanya tanpa memeriksa.',
            },
            totalLine: {
              type: ['string', 'null'],
              description: 'Baris yang menghasilkan totalnya, supaya dapat diperiksa pengguna.',
            },
          },
        },

        Answer: {
          type: 'object',
          required: ['question', 'intent', 'answer', 'grounding', 'amount'],
          additionalProperties: false,
          description:
            'Jawaban GROUNDED. Seluruh angka dihitung server dari basis data; model bahasa tidak pernah menghitung maupun memutuskan apa yang ditanyakan.',
          properties: {
            question: { type: 'string' },
            intent: {
              type: ['string', 'null'],
              enum: [
                'spend_total',
                'income_total',
                'spend_by_category',
                'top_categories',
                'balance',
                'largest_expense',
                'budget_status',
                'subscriptions',
                'runway',
                'net_flow',
                null,
              ],
              description:
                'null berarti maksudnya tidak dikenali. Menebak menghasilkan angka yang benar untuk pertanyaan yang salah.',
            },
            answer: { type: 'string', description: 'Boleh ditampilkan apa adanya.' },
            grounding: {
              type: ['string', 'null'],
              description:
                'Dari mana angkanya. Inilah yang membedakan jawaban yang dapat diperiksa dari kalimat yang terdengar meyakinkan.',
            },
            amount: { type: ['integer', 'null'] },
          },
        },

        Empty: { type: 'object', additionalProperties: false },
      },
    },

    paths: {
      '/livez': {
        get: {
          tags: ['kesehatan'],
          summary: 'Apakah proses ini harus dibunuh dan dijalankan ulang?',
          description:
            'TIDAK PERNAH menyentuh dependensi. Basis data yang jatuh bukan alasan membunuh proses.',
          responses: { '200': { description: 'hidup', content: json(envelope(ref('Empty'))) } },
        },
      },

      '/readyz': {
        get: {
          tags: ['kesehatan'],
          summary: 'Apakah proses ini boleh menerima lalu lintas sekarang?',
          responses: {
            '200': { description: 'siap', content: json(envelope(ref('Empty'))) },
            '503': { description: 'belum siap', content: json(envelope(ref('Empty'))) },
          },
        },
      },

      '/healthz': {
        get: {
          tags: ['kesehatan'],
          summary: 'Ringkasan untuk manusia dan pemantauan',
          responses: { '200': { description: 'ringkasan', content: json(envelope(ref('Empty'))) } },
        },
      },

      '/.well-known/jwks.json': {
        get: {
          tags: ['autentikasi'],
          summary: 'Kunci publik penanda tangan access token',
          description: 'Di-cache sepuluh menit. Kunci privat tidak pernah ikut.',
          responses: { '200': { description: 'JWKS', content: json({ type: 'object' }) } },
        },
      },

      '/openapi.json': {
        get: {
          tags: ['kesehatan'],
          summary: 'Dokumen ini sendiri',
          responses: { '200': { description: 'OpenAPI 3.1', content: json({ type: 'object' }) } },
        },
      },

      '/v1/auth/register': {
        post: {
          tags: ['autentikasi'],
          summary: 'Membuat akun tertunda dan mengantrekan kode verifikasi',
          description:
            'SENGAJA membocorkan bahwa email sudah terpakai (§12) — tanpa pesan itu pengguna yang lupa pernah mendaftar tidak punya jalan keluar. Asimetri terhadap pemulihan disadari dan diterima.',
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['fullName', 'email', 'password', 'device'],
              additionalProperties: false,
              properties: {
                fullName: { type: 'string', minLength: 1, maxLength: 120 },
                email: { type: 'string', format: 'email', maxLength: 254 },
                password: { type: 'string', minLength: 8, maxLength: 512 },
                device: DEVICE,
              },
            }),
          },
          responses: {
            '201': { description: 'menunggu verifikasi', content: json(envelope(ref('PendingVerification'))) },
            ...errors('email_taken', 'weak_password', 'invalid_credentials', 'unknown'),
          },
        },
      },

      '/v1/auth/verify': {
        post: {
          tags: ['autentikasi'],
          summary: 'Menukar tiket dan kode dengan sesi',
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['ticket', 'code', 'device'],
              additionalProperties: false,
              properties: {
                ticket: { type: 'string', maxLength: 256 },
                code: { type: 'string', minLength: 4, maxLength: 12 },
                device: DEVICE,
              },
            }),
          },
          responses: {
            '200': { description: 'sesi', content: json(envelope(ref('Session'))) },
            ...errors('invalid_code', 'code_expired', 'unknown'),
          },
        },
      },

      '/v1/auth/sign-in': {
        post: {
          tags: ['autentikasi'],
          summary: 'Menukar kredensial dengan sesi',
          description:
            'Penguncian diperiksa SEBELUM kredensial dibandingkan (§13). Email tak dikenal dan sandi salah menghasilkan kode yang sama persis.',
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['email', 'password', 'device'],
              additionalProperties: false,
              properties: {
                email: { type: 'string', format: 'email', maxLength: 254 },
                password: { type: 'string', maxLength: 512 },
                device: DEVICE,
              },
            }),
          },
          responses: {
            '200': { description: 'sesi', content: json(envelope(ref('Session'))) },
            ...errors('invalid_credentials', 'rate_limited', 'unknown'),
          },
        },
      },

      '/v1/auth/refresh': {
        post: {
          tags: ['autentikasi'],
          summary: 'Merotasi refresh token',
          description:
            'Token lama dicabut saat yang baru diterbitkan. Pemakaian ulang mencabut SELURUH keluarga (§5.2). Pengulangan di dalam jendela grace 10 detik mengembalikan respons yang sama (§5.3).',
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['refreshToken', 'device'],
              additionalProperties: false,
              properties: {
                refreshToken: { type: 'string', minLength: 16, maxLength: 256 },
                device: DEVICE,
              },
            }),
          },
          responses: {
            '200': { description: 'token baru', content: json(envelope(ref('AuthTokens'))) },
            ...errors('session_expired', 'unknown'),
          },
        },
      },

      '/v1/auth/password/forgot': {
        post: {
          tags: ['autentikasi'],
          summary: 'Memulai pemulihan sandi',
          description:
            'SELALU 200, termasuk untuk email yang tidak terdaftar (§11) — jawaban berbeda akan menjadikan layar ini alat menguji alamat mana yang ada. Yang tak dikenal menerima tiket hantu yang tidak pernah bisa ditukar.',
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['email'],
              additionalProperties: false,
              properties: { email: { type: 'string', format: 'email', maxLength: 254 } },
            }),
          },
          responses: {
            '200': { description: 'tiket', content: json(envelope(ref('PendingVerification'))) },
            ...errors('rate_limited', 'unknown'),
          },
        },
      },

      '/v1/auth/password/reset': {
        post: {
          tags: ['autentikasi'],
          summary: 'Menyelesaikan pemulihan sandi',
          description:
            'Mencabut SELURUH sesi dan TIDAK menerbitkan sesi baru (§11). Siapa pun yang menguasai kotak masuk tidak otomatis berhak masuk tanpa membuktikan sandi barunya.',
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['ticket', 'code', 'newPassword'],
              additionalProperties: false,
              properties: {
                ticket: { type: 'string', maxLength: 256 },
                code: { type: 'string', minLength: 4, maxLength: 12 },
                newPassword: { type: 'string', minLength: 8, maxLength: 512 },
              },
            }),
          },
          responses: {
            '200': { description: 'sandi diganti', content: json(envelope(ref('Empty'))) },
            ...errors('invalid_code', 'code_expired', 'weak_password', 'unknown'),
          },
        },
      },

      '/v1/auth/sign-out': {
        post: {
          tags: ['autentikasi'],
          summary: 'Mencabut keluarga token',
          description:
            'Memakai refresh token di badan, BUKAN Bearer di header (§6) — batas diam 15 menit memanggil rute ini ketika access token 10 menit sudah mati lima menit sebelumnya. SELALU 200.',
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['refreshToken'],
              additionalProperties: false,
              properties: { refreshToken: { type: 'string', minLength: 16, maxLength: 256 } },
            }),
          },
          responses: { '200': { description: 'keluar', content: json(envelope(ref('Empty'))) } },
        },
      },

      '/v1/auth/me': {
        get: {
          tags: ['autentikasi'],
          summary: 'Pemilik access token',
          security: SECURED,
          responses: {
            '200': { description: 'pengguna', content: json(envelope(ref('User'))) },
            ...errors('session_expired'),
          },
        },
      },

      '/v1/auth/sessions': {
        get: {
          tags: ['autentikasi'],
          summary: 'Sesi yang masih terbuka milik pemanggil',
          security: SECURED,
          responses: {
            '200': {
              description: 'sesi aktif, terbaru dipakai lebih dulu',
              content: json(envelope({ type: 'array', items: ref('ActiveSession') })),
            },
            ...errors('session_expired'),
          },
        },
      },

      '/v1/auth/sessions/{id}': {
        delete: {
          tags: ['autentikasi'],
          summary: 'Mengakhiri satu sesi',
          description:
            'Mencabut seluruh keluarga refresh token sesi itu dan menutupnya. Sesi milik ' +
            'pengguna lain dijawab 404 — bukan 403 — supaya penebak id tidak memperoleh ' +
            'konfirmasi bahwa id yang dicobanya ada.',
          security: SECURED,
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'sesi diakhiri', content: json(envelope({ type: 'object' })) },
            ...errors('session_expired', 'not_found'),
          },
        },
      },

      '/v1/accounts': {
        get: {
          tags: ['dompet'],
          summary: 'Daftar dompet beserta saldo terhitung',
          security: SECURED,
          responses: {
            '200': {
              description: 'dompet',
              content: json(envelope({ type: 'array', items: ref('WalletAccount') })),
            },
            ...errors('session_expired'),
          },
        },
        post: {
          tags: ['dompet'],
          summary: 'Membuat dompet',
          security: SECURED,
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['name', 'kind'],
              additionalProperties: false,
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 80 },
                kind: { type: 'string', enum: ['cash', 'bank', 'ewallet', 'card', 'investment'] },
                currency: { type: 'string', minLength: 3, maxLength: 3 },
                openingBalance: {
                  type: 'integer',
                  description: 'Boleh negatif — kartu kredit dimulai dari utang.',
                },
                color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
              },
            }),
          },
          responses: {
            '201': { description: 'dompet', content: json(envelope(ref('WalletAccount'))) },
            ...errors('invalid_input', 'conflict', 'session_expired'),
          },
        },
      },

      '/v1/accounts/{id}': {
        patch: {
          tags: ['dompet'],
          summary: 'Mengubah atau mengarsipkan dompet',
          security: SECURED,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 80 },
                kind: { type: 'string', enum: ['cash', 'bank', 'ewallet', 'card', 'investment'] },
                color: { type: ['string', 'null'] },
                archived: { type: 'boolean' },
              },
            }),
          },
          responses: {
            '200': { description: 'dompet', content: json(envelope(ref('WalletAccount'))) },
            ...errors('not_found', 'invalid_input', 'session_expired'),
          },
        },
      },

      '/v1/categories': {
        get: {
          tags: ['dompet'],
          summary: 'Kategori bawaan sistem dan milik pengguna',
          security: SECURED,
          responses: {
            '200': {
              description: 'kategori',
              content: json(envelope({ type: 'array', items: ref('Category') })),
            },
            ...errors('session_expired'),
          },
        },
        post: {
          tags: ['dompet'],
          summary: 'Membuat kategori milik pengguna',
          security: SECURED,
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['name', 'kind', 'icon', 'color'],
              additionalProperties: false,
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 60 },
                kind: { type: 'string', enum: ['income', 'expense'] },
                icon: { type: 'string', minLength: 1, maxLength: 40 },
                color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
              },
            }),
          },
          responses: {
            '201': { description: 'kategori', content: json(envelope(ref('Category'))) },
            ...errors('invalid_input', 'conflict', 'session_expired'),
          },
        },
      },

      '/v1/categories/{id}': {
        patch: {
          tags: ['dompet'],
          summary: 'Mengubah kategori milik pengguna',
          description: 'Kategori bawaan sistem tidak dapat diubah — ia dibagi seluruh pengguna.',
          security: SECURED,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 60 },
                icon: { type: 'string', minLength: 1, maxLength: 40 },
                color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
              },
            }),
          },
          responses: {
            '200': { description: 'kategori', content: json(envelope(ref('Category'))) },
            ...errors('not_found', 'invalid_input', 'session_expired'),
          },
        },
        delete: {
          tags: ['dompet'],
          summary: 'Mengarsipkan kategori milik pengguna',
          security: SECURED,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'diarsipkan', content: json(envelope(ref('Empty'))) },
            ...errors('not_found', 'session_expired'),
          },
        },
      },

      '/v1/transactions': {
        get: {
          tags: ['transaksi'],
          summary: 'Daftar transaksi, berkursor',
          security: SECURED,
          parameters: [
            { name: 'accountId', in: 'query', schema: { type: 'string' } },
            { name: 'categoryId', in: 'query', schema: { type: 'string' } },
            {
              name: 'kind',
              in: 'query',
              schema: { type: 'string', enum: ['income', 'expense', 'transfer'] },
            },
            { name: 'from', in: 'query', schema: { type: 'integer' }, description: 'Epoch ms.' },
            { name: 'to', in: 'query', schema: { type: 'integer' }, description: 'Epoch ms.' },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          ],
          responses: {
            '200': { description: 'halaman', content: json(envelope(ref('TransactionPage'))) },
            ...errors('invalid_input', 'session_expired'),
          },
        },
        post: {
          tags: ['transaksi'],
          summary: 'Mencatat transaksi',
          description:
            'Transfer adalah SATU baris dengan dua dompet, bukan sepasang baris — sepasang baris dapat kehilangan pasangannya.',
          security: SECURED,
          requestBody: { required: true, content: json(ref('TransactionInput')) },
          responses: {
            '201': { description: 'transaksi', content: json(envelope(ref('Transaction'))) },
            ...errors('not_found', 'invalid_input', 'session_expired'),
          },
        },
      },

      '/v1/transactions/{id}': {
        put: {
          tags: ['transaksi'],
          summary: 'Mengganti transaksi',
          security: SECURED,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: json(ref('TransactionInput')) },
          responses: {
            '200': { description: 'transaksi', content: json(envelope(ref('Transaction'))) },
            ...errors('not_found', 'invalid_input', 'session_expired'),
          },
        },
        delete: {
          tags: ['transaksi'],
          summary: 'Menghapus transaksi (hapus lunak)',
          description:
            'Pembukuan yang barisnya benar-benar hilang tidak dapat diaudit, dan yang tidak dapat diaudit tidak layak disebut pembukuan.',
          security: SECURED,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'dihapus', content: json(envelope(ref('Empty'))) },
            ...errors('not_found', 'session_expired'),
          },
        },
      },

      '/v1/budgets': {
        get: {
          tags: ['rencana'],
          summary: 'Anggaran berjalan beserta terpakainya',
          security: SECURED,
          responses: {
            '200': {
              description: 'anggaran',
              content: json(envelope({ type: 'array', items: ref('Budget') })),
            },
            ...errors('session_expired'),
          },
        },
        post: {
          tags: ['rencana'],
          summary: 'Membuat anggaran',
          description: 'Satu anggaran berjalan per kategori. Hanya kategori pengeluaran.',
          security: SECURED,
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['categoryId', 'amount'],
              additionalProperties: false,
              properties: {
                categoryId: { type: 'string' },
                period: { type: 'string', enum: ['weekly', 'monthly', 'yearly'], default: 'monthly' },
                amount: { type: 'integer', minimum: 1 },
                currency: { type: 'string', minLength: 3, maxLength: 3 },
              },
            }),
          },
          responses: {
            '201': { description: 'anggaran', content: json(envelope(ref('Budget'))) },
            ...errors('not_found', 'invalid_input', 'conflict', 'session_expired'),
          },
        },
      },

      '/v1/budgets/{id}': {
        delete: {
          tags: ['rencana'],
          summary: 'Menghentikan anggaran',
          description:
            'Ditutup dengan tanggal akhir, bukan dihapus — periode yang sudah lewat tetap dapat dibaca apa adanya.',
          security: SECURED,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'dihentikan', content: json(envelope(ref('Empty'))) },
            ...errors('not_found', 'session_expired'),
          },
        },
      },

      '/v1/goals': {
        get: {
          tags: ['rencana'],
          summary: 'Tujuan menabung',
          security: SECURED,
          responses: {
            '200': {
              description: 'tujuan',
              content: json(envelope({ type: 'array', items: ref('Goal') })),
            },
            ...errors('session_expired'),
          },
        },
        post: {
          tags: ['rencana'],
          summary: 'Membuat tujuan',
          security: SECURED,
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['name', 'targetAmount'],
              additionalProperties: false,
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 80 },
                targetAmount: { type: 'integer', minimum: 1 },
                currency: { type: 'string', minLength: 3, maxLength: 3 },
                targetDate: { type: 'string', format: 'date' },
                color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
              },
            }),
          },
          responses: {
            '201': { description: 'tujuan', content: json(envelope(ref('Goal'))) },
            ...errors('invalid_input', 'conflict', 'session_expired'),
          },
        },
      },

      '/v1/goals/{id}': {
        delete: {
          tags: ['rencana'],
          summary: 'Menghapus tujuan',
          security: SECURED,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'dihapus', content: json(envelope(ref('Empty'))) },
            ...errors('not_found', 'session_expired'),
          },
        },
      },

      '/v1/goals/{id}/contribute': {
        post: {
          tags: ['rencana'],
          summary: 'Menambah atau menarik tabungan tujuan',
          description:
            'Penambahan dikerjakan basis data (`saved_amount + $1`), bukan baca-lalu-tulis di aplikasi. Tabungan tidak pernah menjadi negatif.',
          security: SECURED,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['amount'],
              additionalProperties: false,
              properties: {
                amount: { type: 'integer', description: 'Negatif berarti penarikan.' },
              },
            }),
          },
          responses: {
            '200': { description: 'tujuan', content: json(envelope(ref('Goal'))) },
            ...errors('not_found', 'invalid_input', 'session_expired'),
          },
        },
      },

      '/v1/analytics/cashflow': {
        get: {
          tags: ['analitik'],
          summary: 'Arus kas per hari atau per bulan',
          description:
            'Transfer TIDAK dihitung: memindahkan uang antar dompet sendiri bukan pemasukan maupun pengeluaran.',
          security: SECURED,
          parameters: [
            { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365 } },
            { name: 'months', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 60 } },
          ],
          responses: {
            '200': {
              description: 'titik arus kas',
              content: json(envelope({ type: 'array', items: ref('CashflowPoint') })),
            },
            ...errors('invalid_input', 'session_expired'),
          },
        },
      },

      '/v1/insights': {
        get: {
          tags: ['wawasan'],
          summary: 'Anomali, langganan hantu, risiko anggaran, dan proyeksi arus kas',
          description:
            'SELURUHNYA deterministik — tidak ada model, tidak ada panggilan jaringan. Setiap wawasan membawa `reason` berisi angka yang mendasarinya.',
          security: SECURED,
          responses: {
            '200': { description: 'ringkasan wawasan', content: json(envelope(ref('InsightDigest'))) },
            ...errors('session_expired'),
          },
        },
      },

      '/v1/insights/suggestions': {
        get: {
          tags: ['wawasan'],
          summary: 'Usulan kategori untuk transaksi yang belum berkategori',
          description:
            'Berbasis aturan, deterministik, dan dapat dijelaskan. Yang tidak cocok TIDAK diusulkan — menebak menghasilkan kategori salah dengan percaya diri, dan pengguna tidak akan memeriksanya.',
          security: SECURED,
          responses: {
            '200': {
              description: 'usulan',
              content: json(envelope({ type: 'array', items: ref('CategorySuggestion') })),
            },
            ...errors('session_expired'),
          },
        },
      },

      '/v1/insights/suggestions/apply': {
        post: {
          tags: ['wawasan'],
          summary: 'Menerapkan satu usulan kategori',
          description:
            'Eksplisit dan satu per satu, bukan otomatis di latar belakang. Kategorisasi yang berubah sendiri membuat laporan bulan lalu berbeda setiap kali dibuka.',
          security: SECURED,
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['transactionId', 'categoryId'],
              additionalProperties: false,
              properties: {
                transactionId: { type: 'string' },
                categoryId: { type: 'string' },
              },
            }),
          },
          responses: {
            '200': { description: 'diterapkan', content: json(envelope(ref('Empty'))) },
            ...errors('not_found', 'invalid_input', 'session_expired'),
          },
        },
      },

      '/v1/assistant/summary': {
        get: {
          tags: ['asisten'],
          summary: 'Ringkasan naratif periode berjalan',
          description:
            'Angkanya dihitung server dan TIDAK PERNAH datang dari model. Model hanya menyusun kalimatnya, dan menerima angka agregat saja — tanpa nama, merchant, maupun id. Tanpa kredensial model, narasinya bertemplat dan `narrativeSource` mengatakannya.',
          security: SECURED,
          responses: {
            '200': { description: 'ringkasan', content: json(envelope(ref('PeriodSummary'))) },
            ...errors('session_expired'),
          },
        },
      },

      '/v1/assistant/ask': {
        post: {
          tags: ['asisten'],
          summary: 'Bertanya tentang data sendiri dengan bahasa biasa',
          description:
            'Maksud pertanyaan dikenali secara DETERMINISTIK, dan seluruh angka dihitung server. Model bahasa tidak pernah memutuskan apa yang ditanyakan maupun menghitung jawabannya. Pertanyaan di luar cakupan menjawab `intent: null` beserta daftar apa yang bisa ditanyakan — bukan angka yang benar untuk pertanyaan yang salah.',
          security: SECURED,
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['question'],
              additionalProperties: false,
              properties: { question: { type: 'string', minLength: 3, maxLength: 300 } },
            }),
          },
          responses: {
            '200': { description: 'jawaban', content: json(envelope(ref('Answer'))) },
            ...errors('invalid_input', 'session_expired'),
          },
        },
      },

      '/v1/assistant/simulate': {
        post: {
          tags: ['asisten'],
          summary: 'Simulasi komitmen bulanan baru',
          description:
            'Menjawab "kalau saya ambil komitmen ini, aman tidak?" dengan aritmetika dari pemasukan dan pengeluaran sembilan puluh hari terakhir.',
          security: SECURED,
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['monthlyCommitment', 'months'],
              additionalProperties: false,
              properties: {
                monthlyCommitment: { type: 'integer', minimum: 1 },
                months: { type: 'integer', minimum: 1, maximum: 360 },
              },
            }),
          },
          responses: {
            '200': { description: 'simulasi', content: json(envelope(ref('Simulation'))) },
            ...errors('invalid_input', 'session_expired'),
          },
        },
      },

      '/v1/receipts/scan': {
        post: {
          tags: ['struk'],
          summary: 'Membaca foto struk menjadi rancangan transaksi',
          description:
            'OCR LOKAL lewat Tesseract — tanpa akun, tanpa biaya per gambar, dan tanpa satu pun foto struk meninggalkan mesin. Gambar dikirim mentah di badan permintaan, bukan multipart. Batas 8 MB; isi diperiksa dari tanda tangan berkas, bukan dari content-type.',
          security: SECURED,
          requestBody: {
            required: true,
            content: {
              'image/jpeg': { schema: { type: 'string', format: 'binary' } },
              'image/png': { schema: { type: 'string', format: 'binary' } },
              'image/webp': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: {
            '200': { description: 'rancangan', content: json(envelope(ref('ReceiptDraft'))) },
            ...errors('invalid_input', 'session_expired'),
          },
        },
      },

      '/v1/dashboard': {
        get: {
          tags: ['analitik'],
          summary: 'Ringkasan dasbor',
          security: SECURED,
          responses: {
            '200': { description: 'ringkasan', content: json(envelope(ref('DashboardSummary'))) },
            ...errors('session_expired'),
          },
        },
      },
    },
  };
}

/**
 * Menyajikan dokumen.
 *
 * Dibangun sekali saat pendaftaran rute, bukan per permintaan — isinya tidak
 * berubah selama proses hidup, dan menyusunnya ulang ribuan kali adalah
 * pekerjaan yang tidak menghasilkan apa pun.
 */
export function registerOpenApi(app: App, baseUrl: string): void {
  const document = buildOpenApiDocument(baseUrl);

  app.get('/openapi.json', (_request, reply) => {
    void reply.header('cache-control', 'public, max-age=300').send(document);
  });
}
