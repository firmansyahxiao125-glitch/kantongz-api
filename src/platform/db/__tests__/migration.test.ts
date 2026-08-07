import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Validasi migrasi terhadap PostgreSQL yang SUNGGUHAN.
 *
 * PGlite adalah PostgreSQL yang dikompilasi ke WASM dan berjalan di dalam
 * proses — bukan tiruan, bukan simulasi. Parser, perencana, dan penegakan
 * batasannya sama. Yang tidak ada hanya replikasi dan proses latar.
 *
 * Alasannya praktis: migrasi yang hanya diperiksa dengan membaca SQL tidak
 * pernah membuktikan apa pun. Migrasi yang benar-benar diterapkan membuktikan
 * sintaksis, urutan ketergantungan, dan setiap batasan sekaligus.
 *
 * Produksi tetap memakai PostgreSQL 16 lewat Compose sesuai spesifikasi.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Drizzle memisahkan pernyataan dengan penanda ini di dalam satu berkas. */
const BREAKPOINT = '--> statement-breakpoint';

async function applyMigrations(db: PGlite): Promise<void> {
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of sql.split(BREAKPOINT)) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await db.exec(trimmed);
    }
  }
}

describe('migrasi', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
  }, 60_000);

  it('menghasilkan setidaknya satu berkas migrasi', () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
  });

  it('membuat seluruh tabel yang dituntut spesifikasi', async () => {
    const res = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = new Set(res.rows.map((r) => r.table_name));

    /* Kehadiran, bukan kesetaraan persis. Daftar §7 adalah lantai yang tidak
       boleh turun; domain yang ditambahkan sesudahnya menambah tabel dan tidak
       boleh membuat penjaga ini berbunyi. */
    for (const table of [
      'audit_log',
      'devices',
      'outbox',
      'permissions',
      'refresh_tokens',
      'role_permissions',
      'roles',
      'sessions',
      'tickets',
      'user_roles',
      'users',
    ]) {
      expect(names, table).toContain(table);
    }
  });

  it('membuat seluruh tabel buku besar', async () => {
    const res = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = new Set(res.rows.map((r) => r.table_name));

    for (const table of ['wallet_accounts', 'categories', 'transactions', 'budgets', 'goals']) {
      expect(names, table).toContain(table);
    }
  });

  /**
   * Batasan CHECK diperiksa di sini dan bukan hanya lewat uji layanan.
   *
   * Uji layanan membuktikan lapisan layanan menolaknya; ini membuktikan basis
   * data menolaknya juga. Keduanya diperlukan, karena jalur tulis akan
   * bertambah dan yang baru bisa lupa memeriksa.
   */
  it('menolak transaksi bertanda negatif di tingkat basis data', async () => {
    await db.exec(
      `INSERT INTO users (id,email_hash,hmac_key_version,email_encrypted,full_name_encrypted,password_hash)
       VALUES ('u_check','\\x00',1,'\\x00','\\x00','x')`,
    );
    await db.exec(
      `INSERT INTO wallet_accounts (id,user_id,name,kind) VALUES ('a_check','u_check','Kas','cash')`,
    );

    await expect(
      db.exec(
        `INSERT INTO transactions (id,user_id,account_id,kind,amount,occurred_at)
         VALUES ('t_neg','u_check','a_check','expense',-1,now())`,
      ),
    ).rejects.toThrow();

    /* Transfer tanpa dompet tujuan melanggar `transactions_transfer_shape`. */
    await expect(
      db.exec(
        `INSERT INTO transactions (id,user_id,account_id,kind,amount,occurred_at)
         VALUES ('t_bad','u_check','a_check','transfer',1000,now())`,
      ),
    ).rejects.toThrow();
  }, 30_000);

  it('membuat kedua enum dengan nilai yang benar', async () => {
    const res = await db.query<{ typname: string; enumlabel: string }>(
      `SELECT t.typname, e.enumlabel FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname IN ('account_status','ticket_purpose')
        ORDER BY t.typname, e.enumsortorder`,
    );

    const byType = new Map<string, string[]>();
    for (const row of res.rows) {
      byType.set(row.typname, [...(byType.get(row.typname) ?? []), row.enumlabel]);
    }

    expect(byType.get('account_status')).toEqual([
      'pending_verification',
      'active',
      'locked',
      'suspended',
      'closed',
    ]);
    expect(byType.get('ticket_purpose')).toEqual(['email_verification', 'password_reset']);
  });

  /**
   * Indeks parsial ini menutup temuan audit MEDIUM-3: penghapusan akun tidak
   * boleh menghalangi pendaftaran ulang dengan alamat yang sama.
   */
  it('membuat indeks unik email hanya untuk akun hidup', async () => {
    const res = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'users_email_active'`,
    );

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.indexdef).toContain('UNIQUE');
    expect(res.rows[0]?.indexdef).toContain('deleted_at IS NULL');
  });

  it('menegakkan email unik hanya di antara akun hidup', async () => {
    const insert = (id: string, deleted: string) =>
      db.exec(`INSERT INTO users
          (id, email_hash, hmac_key_version, email_encrypted, full_name_encrypted,
           password_hash, deleted_at)
        VALUES ('${id}', '\\x0102'::bytea, 1, '\\x03'::bytea, '\\x04'::bytea, 'x', ${deleted})`);

    await insert('u1', 'NULL');
    /* Baris kedua dengan email sama TETAPI sudah dihapus — harus diterima. */
    await insert('u2', "'2020-01-01T00:00:00Z'");

    /* Baris ketiga yang hidup dengan email sama — harus ditolak. */
    await expect(insert('u3', 'NULL')).rejects.toThrow();
  });

  it('menuntut hmac_key_version di setiap tabel ber-HMAC', async () => {
    const res = await db.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable FROM information_schema.columns
        WHERE column_name = 'hmac_key_version' ORDER BY table_name`,
    );

    expect(res.rows.map((r) => r.table_name)).toEqual(['audit_log', 'devices', 'users']);
    expect(res.rows.every((r) => r.is_nullable === 'NO')).toBe(true);
  });

  /** `sessions.id` ADALAH identitas keluarga token — tidak ada kolom kedua. */
  it('tidak memiliki kolom family_id di mana pun', async () => {
    const res = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE column_name = 'family_id'`,
    );
    expect(Number(res.rows[0]?.n)).toBe(0);
  });

  it('menegakkan idempotency_key outbox sebagai unik', async () => {
    const ins = (id: string) =>
      db.exec(
        `INSERT INTO outbox (id, topic, idempotency_key, payload)
         VALUES ('${id}', 'email.verify', 'kunci-sama', '{}'::jsonb)`,
      );

    await ins('o1');
    await expect(ins('o2')).rejects.toThrow();
  });

  it('menghapus perangkat dan sesi saat pengguna dihapus', async () => {
    await db.exec(`INSERT INTO users (id, email_hash, hmac_key_version, email_encrypted,
        full_name_encrypted, password_hash)
      VALUES ('u9', '\\x09'::bytea, 1, '\\x09'::bytea, '\\x09'::bytea, 'x')`);
    await db.exec(`INSERT INTO devices (id, user_id, device_hash, hmac_key_version, platform)
      VALUES ('d9', 'u9', '\\x09'::bytea, 1, 'android')`);
    await db.exec(`INSERT INTO sessions (id, user_id, device_id, absolute_expires_at)
      VALUES ('s9', 'u9', 'd9', now() + interval '90 days')`);
    await db.exec(`INSERT INTO refresh_tokens (id, session_id, token_hash, generation, expires_at)
      VALUES ('r9', 's9', '\\x99'::bytea, 1, now() + interval '30 days')`);

    await db.exec(`DELETE FROM users WHERE id = 'u9'`);

    for (const table of ['devices', 'sessions', 'refresh_tokens']) {
      const res = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(Number(res.rows[0]?.n)).toBe(0);
    }
  });
});
