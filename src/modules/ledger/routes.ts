import { z } from 'zod';

import { AppError } from '../../contracts/errors.js';
import { DomainError } from '../../contracts/domain.js';
import { success } from '../../http/envelope.js';
import type { App } from '../../http/types.js';
import { verifyAccessToken, type IssuerConfig } from '../tokens/jwt.js';
import type { KeyRing } from '../tokens/keys.js';
import { MAX_ROWS, importTransactions } from './impor.js';
import * as recurring from './recurring.js';
import * as service from './service.js';
import type { LedgerDeps } from './service.js';

/**
 * Rute buku besar. Menerjemahkan HTTP, tidak memutuskan apa pun.
 *
 * SETIAP rute di sini menuntut access token dan mengambil `userId` dari
 * klaimnya — TIDAK PERNAH dari badan atau parameter permintaan. Id pengguna yang
 * datang dari klien berarti siapa pun dapat membaca pembukuan siapa pun.
 */

export interface LedgerRouteDeps extends LedgerDeps {
  ring: KeyRing;
  issuer: IssuerConfig;
}

const id = z.string().min(1).max(64);
const amount = z.number().int();
const currency = z.string().length(3);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const schemas = {
  createAccount: z.object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['cash', 'bank', 'ewallet', 'card', 'investment']),
    currency: currency.optional(),
    openingBalance: amount.optional(),
    color: hexColor.optional(),
  }),
  updateAccount: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    kind: z.enum(['cash', 'bank', 'ewallet', 'card', 'investment']).optional(),
    color: hexColor.nullable().optional(),
    archived: z.boolean().optional(),
  }),
  createCategory: z.object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(['income', 'expense']),
    icon: z.string().min(1).max(40),
    color: hexColor,
  }),
  updateCategory: z.object({
    name: z.string().trim().min(1).max(60).optional(),
    icon: z.string().min(1).max(40).optional(),
    color: hexColor.optional(),
  }),
  transaction: z.object({
    accountId: id,
    counterAccountId: id.optional(),
    categoryId: id.optional(),
    kind: z.enum(['income', 'expense', 'transfer']),
    amount: amount.positive(),
    occurredAt: z.number().int().positive(),
    note: z.string().trim().max(280).optional(),
    merchant: z.string().trim().max(120).optional(),
  }),
  transactionQuery: z.object({
    accountId: id.optional(),
    categoryId: id.optional(),
    kind: z.enum(['income', 'expense', 'transfer']).optional(),
    from: z.coerce.number().int().positive().optional(),
    to: z.coerce.number().int().positive().optional(),
    cursor: z.string().min(3).max(96).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  createBudget: z.object({
    categoryId: id,
    period: z.enum(['weekly', 'monthly', 'yearly']).default('monthly'),
    amount: amount.positive(),
    currency: currency.optional(),
    rollover: z.boolean().optional(),
  }),
  updateBudget: z.object({ rollover: z.boolean() }),
  createGoal: z.object({
    name: z.string().trim().min(1).max(80),
    targetAmount: amount.positive(),
    currency: currency.optional(),
    targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    color: hexColor.optional(),
  }),
  contribute: z.object({ amount: amount }),
  recurring: z.object({
    name: z.string().trim().min(1).max(80),
    accountId: id,
    counterAccountId: id.optional(),
    categoryId: id.optional(),
    kind: z.enum(['income', 'expense', 'transfer']),
    amount: amount.positive(),
    merchant: z.string().trim().max(120).optional(),
    note: z.string().trim().max(280).optional(),
    cadence: z.enum(['daily', 'weekly', 'monthly']),
    interval: z.number().int().min(1).max(366).default(1),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  pauseRecurring: z.object({ paused: z.boolean() }),
  /* G2. Panjangnya dibatasi seperti kolom merchant di transaksi — masukan
     yang lebih panjang daripada yang mungkin tersimpan tidak dapat berasal
     dari pemakaian yang sah. */
  suggestQuery: z.object({ merchant: z.string().trim().min(1).max(120) }),
  /* F3. Jumlahnya TIDAK diperiksa di sini: ia bergantung pada nominal
     transaksi, yang baru diketahui sesudah kepemilikannya terbukti. Skema
     hanya menjaga bentuknya. */
  splits: z.object({
    splits: z
      .array(
        z.object({
          categoryId: z.string().min(1),
          amount: z.number().int().positive(),
          note: z.string().trim().max(280).optional(),
        }),
      )
      .min(1)
      .max(20),
  }),
  import: z.object({
    /* Bawaannya PRATINJAU. Kelalaian menyertakan bendera ini tidak boleh
       berakhir dengan lima ratus baris yang tertulis tanpa diminta. */
    dryRun: z.boolean().default(true),
    rows: z
      .array(
        z.object({
          accountId: id,
          counterAccountId: id.optional(),
          categoryId: id.optional(),
          kind: z.enum(['income', 'expense', 'transfer']),
          amount: amount.positive(),
          occurredAt: z.number().int().positive(),
          merchant: z.string().trim().max(120).optional(),
          note: z.string().trim().max(280).optional(),
        }),
      )
      .max(MAX_ROWS),
  }),
  cashflowQuery: z.object({
    days: z.coerce.number().int().min(1).max(365).optional(),
    months: z.coerce.number().int().min(1).max(60).optional(),
  }),
};

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  /* Sama seperti rute autentikasi: bentuk masukan yang salah tidak menjelaskan
     dirinya ke klien. Yang menebak-nebak API tidak dibantu menebaknya. */
  if (!result.success) throw new DomainError('invalid_input', 'permintaan tidak valid');
  return result.data;
}

export function registerLedgerRoutes(app: App, deps: LedgerRouteDeps): void {
  /**
   * Identitas pemanggil.
   *
   * Dipanggil di awal SETIAP penangan. Sebuah hook `preHandler` global akan
   * lebih ringkas tetapi juga akan berlaku diam-diam pada rute yang ditambahkan
   * kemudian — termasuk rute yang seharusnya publik dan rute yang lupa
   * diperiksa. Panggilan eksplisit tidak bisa lupa.
   */
  async function callerId(request: { headers: Record<string, unknown> }): Promise<string> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AppError('session_expired');
    }
    const claims = await verifyAccessToken(deps.ring, deps.issuer, header.slice(7));
    return claims.sub;
  }

  /* ── dompet ────────────────────────────────────────────────────────── */

  app.get('/v1/accounts', async (request, reply) => {
    const userId = await callerId(request);
    void reply.send(success(await service.listAccounts(deps, userId), request.requestId));
  });

  app.post('/v1/accounts', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.createAccount, request.body);
    void reply.status(201).send(success(await service.createAccount(deps, userId, body), request.requestId));
  });

  app.patch<{ Params: { id: string } }>('/v1/accounts/:id', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.updateAccount, request.body);
    void reply.send(
      success(await service.updateAccount(deps, userId, request.params.id, body), request.requestId),
    );
  });

  /* ── kategori ──────────────────────────────────────────────────────── */

  app.get('/v1/categories', async (request, reply) => {
    const userId = await callerId(request);
    void reply.send(success(await service.listCategories(deps, userId), request.requestId));
  });

  app.post('/v1/categories', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.createCategory, request.body);
    void reply.status(201).send(success(await service.createCategory(deps, userId, body), request.requestId));
  });

  app.patch<{ Params: { id: string } }>('/v1/categories/:id', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.updateCategory, request.body);
    void reply.send(
      success(await service.updateCategory(deps, userId, request.params.id, body), request.requestId),
    );
  });

  app.delete<{ Params: { id: string } }>('/v1/categories/:id', async (request, reply) => {
    const userId = await callerId(request);
    await service.archiveCategory(deps, userId, request.params.id);
    void reply.send(success({}, request.requestId));
  });

  /* ── transaksi ─────────────────────────────────────────────────────── */

  app.get('/v1/transactions', async (request, reply) => {
    const userId = await callerId(request);
    const query = parse(schemas.transactionQuery, request.query);
    void reply.send(success(await service.listTransactions(deps, userId, query), request.requestId));
  });

  /**
   * Usulan kategori dari nama merchant. G2.
   *
   * GET, dan itu keputusan yang disengaja: rute ini tidak mengubah apa pun,
   * jadi ia harus terlihat seperti rute yang tidak mengubah apa pun. Kelirunya
   * memakai POST di sini bukan gaya penulisan — ia mengaburkan satu-satunya
   * jaminan yang membuat fitur ini boleh ada, yaitu bahwa ia MENYARANKAN.
   */
  app.get('/v1/transactions/suggest-category', async (request, reply) => {
    const userId = await callerId(request);
    const query = parse(schemas.suggestQuery, request.query);
    void reply.send(
      success(await service.suggestCategory(deps, userId, query.merchant), request.requestId),
    );
  });

  app.post('/v1/transactions', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.transaction, request.body);
    void reply
      .status(201)
      .send(success(await service.createTransaction(deps, userId, body), request.requestId));
  });

  /**
   * Memecah satu transaksi ke beberapa kategori. F3.
   *
   * PUT, bukan POST: himpunan pecahan diganti SELURUHNYA, dan mengirim badan
   * yang sama dua kali menghasilkan keadaan yang sama. Tambal sebagian
   * menuntut pemanggilnya menjaga sendiri agar jumlahnya tetap cocok dengan
   * nominal transaksi — dan setiap jalur yang lupa meninggalkan pembukuan
   * yang tidak cocok tanpa satu galat pun.
   */
  app.put<{ Params: { id: string } }>('/v1/transactions/:id/splits', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.splits, request.body);
    void reply.send(
      success(
        await service.setTransactionSplits(deps, userId, request.params.id, body.splits),
        request.requestId,
      ),
    );
  });

  app.delete<{ Params: { id: string } }>('/v1/transactions/:id/splits', async (request, reply) => {
    const userId = await callerId(request);
    void reply.send(
      success(
        await service.clearTransactionSplits(deps, userId, request.params.id),
        request.requestId,
      ),
    );
  });

  app.put<{ Params: { id: string } }>('/v1/transactions/:id', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.transaction, request.body);
    void reply.send(
      success(
        await service.updateTransaction(deps, userId, request.params.id, body),
        request.requestId,
      ),
    );
  });

  app.delete<{ Params: { id: string } }>('/v1/transactions/:id', async (request, reply) => {
    const userId = await callerId(request);
    await service.deleteTransaction(deps, userId, request.params.id);
    void reply.send(success({}, request.requestId));
  });

  /* ── anggaran ──────────────────────────────────────────────────────── */

  app.get('/v1/budgets', async (request, reply) => {
    const userId = await callerId(request);
    void reply.send(success(await service.listBudgets(deps, userId), request.requestId));
  });

  app.post('/v1/budgets', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.createBudget, request.body);
    void reply.status(201).send(success(await service.createBudget(deps, userId, body), request.requestId));
  });

  app.delete<{ Params: { id: string } }>('/v1/budgets/:id', async (request, reply) => {
    const userId = await callerId(request);
    await service.closeBudget(deps, userId, request.params.id);
    void reply.send(success({}, request.requestId));
  });

  /* ── tujuan ────────────────────────────────────────────────────────── */

  app.get('/v1/goals', async (request, reply) => {
    const userId = await callerId(request);
    void reply.send(success(await service.listGoals(deps, userId), request.requestId));
  });

  app.post('/v1/goals', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.createGoal, request.body);
    void reply.status(201).send(success(await service.createGoal(deps, userId, body), request.requestId));
  });

  app.post<{ Params: { id: string } }>('/v1/goals/:id/contribute', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.contribute, request.body);
    void reply.send(
      success(
        await service.contributeToGoal(deps, userId, request.params.id, body.amount),
        request.requestId,
      ),
    );
  });

  app.delete<{ Params: { id: string } }>('/v1/goals/:id', async (request, reply) => {
    const userId = await callerId(request);
    await service.deleteGoal(deps, userId, request.params.id);
    void reply.send(success({}, request.requestId));
  });

  app.patch<{ Params: { id: string } }>('/v1/budgets/:id', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.updateBudget, request.body);
    void reply.send(
      success(
        await service.setBudgetRollover(deps, userId, request.params.id, body.rollover),
        request.requestId,
      ),
    );
  });

  /*
   * Impor berkas.
   *
   * `bodyLimit` sendiri, karena batas global 16 KB (§2) memang dipilih untuk
   * badan permintaan yang berisi satu objek. Lima ratus baris transaksi
   * melampauinya jauh — dan batasnya TETAP ADA, hanya digeser ke angka yang
   * dihitung dari batas barisnya sendiri.
   */
  app.post('/v1/transactions/import', { bodyLimit: 1_048_576 }, async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.import, request.body);
    void reply.send(
      success(
        await importTransactions(deps, userId, body.rows, { dryRun: body.dryRun }),
        request.requestId,
      ),
    );
  });

  /* ── aturan berulang ─────────────────────────────────────────────────── */

  app.get('/v1/recurring', async (request, reply) => {
    const userId = await callerId(request);
    void reply.send(success(await recurring.listRecurring(deps, userId), request.requestId));
  });

  app.post('/v1/recurring', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.recurring, request.body);
    void reply
      .status(201)
      .send(success(await recurring.createRecurring(deps, userId, body), request.requestId));
  });

  app.put<{ Params: { id: string } }>('/v1/recurring/:id', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.recurring, request.body);
    void reply.send(
      success(
        await recurring.updateRecurring(deps, userId, request.params.id, body),
        request.requestId,
      ),
    );
  });

  app.post<{ Params: { id: string } }>('/v1/recurring/:id/pause', async (request, reply) => {
    const userId = await callerId(request);
    const body = parse(schemas.pauseRecurring, request.body);
    void reply.send(
      success(
        await recurring.setRecurringPaused(deps, userId, request.params.id, body.paused),
        request.requestId,
      ),
    );
  });

  app.delete<{ Params: { id: string } }>('/v1/recurring/:id', async (request, reply) => {
    const userId = await callerId(request);
    await recurring.deleteRecurring(deps, userId, request.params.id);
    void reply.send(success({}, request.requestId));
  });

  /*
   * Menjalankan yang jatuh tempo SEKARANG, tanpa menunggu putaran pekerja.
   *
   * Bukan rute administratif meski bekerja lintas pengguna: ia HANYA
   * menjalankan aturan yang memang sudah jatuh tempo, dan itu persis yang
   * dikerjakan pekerja tiap menit. Memanggilnya seribu kali menghasilkan
   * keadaan yang sama dengan memanggilnya sekali; yang memanggil tetap wajib
   * membawa sesi yang sah.
   */
  app.post('/v1/recurring/run', async (request, reply) => {
    await callerId(request);
    void reply.send(success(await recurring.runDueRecurring(deps), request.requestId));
  });

  /* ── analitik ──────────────────────────────────────────────────────── */

  app.get('/v1/analytics/cashflow', async (request, reply) => {
    const userId = await callerId(request);
    const query = parse(schemas.cashflowQuery, request.query);
    void reply.send(success(await service.cashflow(deps, userId, query), request.requestId));
  });

  app.get('/v1/dashboard', async (request, reply) => {
    const userId = await callerId(request);
    void reply.send(success(await service.dashboard(deps, userId), request.requestId));
  });
}
