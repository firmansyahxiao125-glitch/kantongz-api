import { describe, expect, it } from 'vitest';

import { rencanakanPemulihan, VERSI_DIDUKUNG } from '../pemulihan.js';

/** Id baru yang deterministik: fungsi yang mengacak sendiri tidak dapat diuji. */
const idUji = (jenis: string, urutan: number): string => `${jenis}-baru-${String(urutan)}`;

function berkas(ubah: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: VERSI_DIDUKUNG,
    exportedAt: '2026-08-15T00:00:00.000Z',
    account: { id: 'usr_lama', email: 'lama@contoh.id', fullName: 'Lama' },
    wallets: [{ id: 'acc_1', name: 'Kas' }, { id: 'acc_2', name: 'Bank' }],
    categories: [{ id: 'cat_1', name: 'Makan' }],
    transactions: [
      { id: 'trx_1', accountId: 'acc_1', categoryId: 'cat_1', amount: 25_000 },
      { id: 'trx_2', accountId: 'acc_2', amount: 10_000 },
    ],
    budgets: [{ id: 'bgt_1', categoryId: 'cat_1', amount: 500_000 }],
    goals: [{ id: 'gol_1', name: 'Dana darurat' }],
    recurring: [{ id: 'rec_1', accountId: 'acc_1', name: 'Langganan' }],
    ...ubah,
  };
}

describe('rencanakanPemulihan · penolakan', () => {
  it('menolak yang bukan objek', () => {
    for (const buruk of [null, 42, 'teks', [1, 2, 3]]) {
      const h = rencanakanPemulihan(buruk, idUji);
      expect(h.ok, JSON.stringify(buruk)).toBe(false);
      if (!h.ok) expect(h.alasan).toBe('bukan_objek');
    }
  });

  it('menolak versi masa depan — DIPERIKSA SEBELUM isinya dibaca', () => {
    /* Berkas dari versi masa depan mungkin berbentuk sama sekali berbeda.
       Membacanya dengan asumsi versi lama menghasilkan pemulihan yang
       "berhasil" dengan data yang salah — kegagalan yang jauh lebih buruk
       daripada penolakan. */
    const h = rencanakanPemulihan(berkas({ schemaVersion: 99, wallets: 'rusak' }), idUji);
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.alasan).toBe('versi_tidak_didukung');
  });

  it('menolak versi yang hilang', () => {
    const b = berkas();
    delete b.schemaVersion;
    const h = rencanakanPemulihan(b, idUji);
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.alasan).toBe('versi_tidak_didukung');
  });

  it('menolak bagian wajib yang hilang', () => {
    const h = rencanakanPemulihan(berkas({ wallets: undefined }), idUji);
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.alasan).toBe('bagian_hilang');
  });

  it('menolak SELURUH berkas bila transaksi menunjuk dompet yang tidak ada', () => {
    /* Berbeda dari impor CSV yang melewati baris rusak: berkas ekspor adalah
       SATU pembukuan yang utuh, dan memulihkan sebagiannya menghasilkan saldo
       yang tidak pernah cocok. */
    const h = rencanakanPemulihan(
      berkas({ transactions: [{ id: 'trx_1', accountId: 'acc_hantu' }] }),
      idUji,
    );
    expect(h.ok).toBe(false);
    if (!h.ok) {
      expect(h.alasan).toBe('rujukan_menggantung');
      expect(h.detail).toContain('acc_hantu');
    }
  });

  it('menolak transfer yang dompet lawannya tidak ada', () => {
    const h = rencanakanPemulihan(
      berkas({
        transactions: [{ id: 'trx_1', accountId: 'acc_1', counterAccountId: 'acc_hantu' }],
      }),
      idUji,
    );
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.alasan).toBe('rujukan_menggantung');
  });
});

describe('rencanakanPemulihan · pemetaan id', () => {
  it('memberi id BARU untuk setiap dompet dan kategori', () => {
    const h = rencanakanPemulihan(berkas(), idUji);
    expect(h.ok).toBe(true);
    if (!h.ok) return;

    expect(h.peta.wallets.get('acc_1')).toBe('wallet-baru-0');
    expect(h.peta.wallets.get('acc_2')).toBe('wallet-baru-1');
    expect(h.peta.categories.get('cat_1')).toBe('category-baru-0');

    /* Tidak satu pun id lama bertahan. Id lama membawa jejak akun lama ke
       dalam akun baru — termasuk ke ekspor berikutnya, selamanya. */
    for (const baru of h.peta.wallets.values()) {
      expect(baru.startsWith('acc_')).toBe(false);
    }
  });

  it('menghitung setiap bagian', () => {
    const h = rencanakanPemulihan(berkas(), idUji);
    if (!h.ok) throw new Error('seharusnya diterima');

    expect(h.jumlah).toEqual({
      wallets: 2,
      categories: 1,
      transactions: 2,
      budgets: 1,
      goals: 1,
      recurring: 1,
    });
  });
});

describe('rencanakanPemulihan · yang dilewati DICATAT, bukan disembunyikan', () => {
  it('melepas kategori sistem dari transaksi tanpa menolak berkasnya', () => {
    /* Kategori sistem tidak ikut diekspor, jadi transaksi lama dapat
       menunjuk kategori yang memang tidak ada di berkas. Menolak seluruh
       berkas karena ini membuat hampir setiap ekspor mustahil dipulihkan. */
    const h = rencanakanPemulihan(
      berkas({
        transactions: [
          { id: 'trx_1', accountId: 'acc_1', categoryId: 'cat_sistem_makan' },
          { id: 'trx_2', accountId: 'acc_1', categoryId: 'cat_1' },
        ],
      }),
      idUji,
    );

    expect(h.ok).toBe(true);
    if (!h.ok) return;
    expect(h.jumlah.transactions).toBe(2);
    expect(h.dilewati.some((d) => d.jenis === 'kategori transaksi')).toBe(true);
    expect(h.dilewati.find((d) => d.jenis === 'kategori transaksi')?.sebab).toContain('1 transaksi');
  });

  it('melewati anggaran yang kategorinya tidak ikut, dan mengurangi hitungannya', () => {
    const h = rencanakanPemulihan(
      berkas({
        budgets: [
          { id: 'bgt_1', categoryId: 'cat_1' },
          { id: 'bgt_2', categoryId: 'cat_sistem' },
        ],
      }),
      idUji,
    );

    if (!h.ok) throw new Error('seharusnya diterima');
    expect(h.jumlah.budgets).toBe(1);
    expect(h.dilewati.some((d) => d.jenis === 'anggaran')).toBe(true);
  });

  it('berkas yang bersih tidak melewati apa pun', () => {
    const h = rencanakanPemulihan(berkas(), idUji);
    if (!h.ok) throw new Error('seharusnya diterima');
    expect(h.dilewati).toEqual([]);
  });

  it('berkas kosong yang sah tetap diterima', () => {
    const h = rencanakanPemulihan(
      { schemaVersion: VERSI_DIDUKUNG, wallets: [], transactions: [] },
      idUji,
    );
    expect(h.ok).toBe(true);
    if (h.ok) expect(h.jumlah.transactions).toBe(0);
  });
});
