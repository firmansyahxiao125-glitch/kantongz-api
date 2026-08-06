import { sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { permissions, rolePermissions, roles } from './schema.js';

/**
 * Data benih: peran dan izin. M3_SPEC §9.
 *
 * M3 hanya membutuhkan satu peran, tetapi tabelnya diisi sekarang karena
 * menambahkan otorisasi ke sistem yang sudah berjalan jauh lebih mahal
 * daripada menyediakannya kosong.
 *
 * Idempoten: `ON CONFLICT DO NOTHING` di setiap sisipan. Benih yang hanya bisa
 * dijalankan sekali adalah benih yang tidak bisa dijalankan di lingkungan yang
 * sudah ada.
 */

/**
 * ATURAN YANG TIDAK BOLEH DILANGGAR (§9): staf tidak pernah bisa membaca saldo
 * atau memulai transaksi. `support` hanya melihat metadata akun dan mencabut
 * sesi.
 */
const ROLES = [
  { id: 'rol_member', name: 'member', description: 'Pemilik akun.' },
  {
    id: 'rol_support',
    name: 'support',
    description: 'Staf dukungan. Metadata akun dan pencabutan sesi saja.',
  },
  { id: 'rol_admin', name: 'admin', description: 'Administrasi peran dan konfigurasi.' },
] as const;

const PERMISSIONS = [
  'account:read:self',
  'account:update:self',
  'session:read:self',
  'session:revoke:self',
  'device:read:self',
  'device:revoke:self',
  'account:read:metadata',
  'session:revoke:any',
  'role:grant',
  'role:revoke',
] as const;

const GRANTS: Record<string, readonly string[]> = {
  rol_member: [
    'account:read:self',
    'account:update:self',
    'session:read:self',
    'session:revoke:self',
    'device:read:self',
    'device:revoke:self',
  ],
  /* Tidak ada `account:read:self` di sini — staf tidak membaca akun sebagai
     pemilik. Tidak ada satu pun izin yang menyentuh nilai uang. */
  rol_support: ['account:read:metadata', 'session:revoke:any'],
  rol_admin: ['account:read:metadata', 'session:revoke:any', 'role:grant', 'role:revoke'],
};

export async function seed(db: Database): Promise<void> {
  await db.insert(roles).values([...ROLES]).onConflictDoNothing();

  await db
    .insert(permissions)
    .values(PERMISSIONS.map((name) => ({ id: `prm_${name.replace(/[:]/g, '_')}`, name })))
    .onConflictDoNothing();

  const pairs = Object.entries(GRANTS).flatMap(([roleId, names]) =>
    names.map((name) => ({ roleId, permissionId: `prm_${name.replace(/[:]/g, '_')}` })),
  );

  await db.insert(rolePermissions).values(pairs).onConflictDoNothing();
}

/** Dipakai uji untuk memastikan benih benar-benar idempoten. */
export async function countSeed(db: Database): Promise<{ roles: number; permissions: number }> {
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM roles`);
  const p = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM permissions`);
  return { roles: Number(r[0]?.n ?? 0), permissions: Number(p[0]?.n ?? 0) };
}
