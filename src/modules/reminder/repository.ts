import { and, eq, gte, isNull, lte } from 'drizzle-orm';

import type { Database } from '../../platform/db/client.js';
import { decryptColumn, type KeyProvider } from '../../platform/crypto/index.js';
import { recurringRules } from '../../platform/db/ledger.js';
import { users } from '../../platform/db/schema.js';
import type { AturanJatuhTempo } from './rencana.js';

/**
 * Pembacaan untuk pengingat jatuh tempo. G1.
 *
 * Satu kueri, satu gabungan, tanpa aturan bisnis. Penyaringan yang benar-benar
 * menentukan siapa diingatkan ada di `rencana.ts` dan dapat diuji tanpa
 * Postgres; yang di sini hanya mempersempit baris supaya putaran tiap menit
 * tidak memindai seluruh tabel.
 */

/**
 * Aturan milik siapa pun yang jatuh temponya berada di dalam jendela.
 *
 * ── MENGAPA HANYA AKUN `active` ────────────────────────────────────────
 *
 * Akun `pending_verification` belum membuktikan alamat emailnya miliknya.
 * Mengirim pengingat ke sana berarti mengirim rincian keuangan — nama tagihan
 * dan nominalnya — ke alamat yang belum pernah dikonfirmasi siapa pun.
 * Akun `locked` dan yang sudah dihapus juga tidak: keduanya berarti tidak ada
 * lagi yang boleh keluar dari akun itu.
 *
 * ── MENGAPA JENDELANYA DILEBIHKAN SEHARI DI KEDUA UJUNG ────────────────
 *
 * Batasnya dihitung dari jam server, sedangkan hari yang benar dihitung di
 * Jakarta. Kueri yang persis akan menjatuhkan baris tepi tepat pada jam-jam
 * pergantian hari. Kelebihan sehari dibayar dengan beberapa baris tambahan
 * yang lalu dibuang perencana — dan tidak pernah dengan pengingat yang hilang.
 */
export interface HasilBaca {
  aturan: AturanJatuhTempo[];
  /**
   * Id pengguna yang barisnya TIDAK dapat didekripsi kunci yang berlaku.
   *
   * Dikembalikan, bukan dilempar, dan bukan pula ditelan diam-diam — lihat
   * alasan lengkapnya di bawah.
   */
  takTerbaca: string[];
}

export async function aturanMendekatiJatuhTempo(
  db: Database,
  keys: KeyProvider,
  dari: string,
  sampai: string,
): Promise<HasilBaca> {
  const rows = await db
    .select({
      id: recurringRules.id,
      userId: recurringRules.userId,
      judul: recurringRules.name,
      jumlah: recurringRules.amount,
      nextRunOn: recurringRules.nextRunOn,
      endsOn: recurringRules.endsOn,
      pausedAt: recurringRules.pausedAt,
      emailEncrypted: users.emailEncrypted,
      fullNameEncrypted: users.fullNameEncrypted,
    })
    .from(recurringRules)
    .innerJoin(users, eq(users.id, recurringRules.userId))
    .where(
      and(
        isNull(recurringRules.pausedAt),
        gte(recurringRules.nextRunOn, dari),
        lte(recurringRules.nextRunOn, sampai),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
      ),
    );

  /* Didekripsi di lapisan ini dan tidak pernah lebih dalam: perencana adalah
     fungsi murni yang diuji dengan data biasa, dan menyerahkan penyedia kunci
     kepadanya akan menyeret kriptografi ke dalam uji aritmetika tanggal. */
  const aturan: AturanJatuhTempo[] = [];
  const takTerbaca: string[] = [];

  for (const r of rows) {
    /*
       ── SATU BARIS YANG TIDAK TERBACA TIDAK BOLEH MEMBUNGKAM SEMUANYA ───

       `decryptColumn` melempar pada baris yang disandikan kunci lain, dan
       versi pertama fungsi ini memakai `.map()` — jadi lemparan itu
       menggagalkan SELURUH pemindaian. Akibatnya bukan "satu pengguna tidak
       diingatkan" melainkan "tidak seorang pun diingatkan, selamanya, sampai
       ada yang membaca log".

       Itu bukan dugaan. Gerbang `scripts/pengingat.mjs` menemukannya pada
       jalanan pertama: 9 pengguna punya aturan berulang di basis data
       pengembangan, 7 barisnya terbaca, 2 tidak — dan ketujuh yang sah tidak
       menerima satu pun pengingat selama enam putaran berturut-turut.

       Sebabnya di sini kebetulan jinak: tumpukan `prod.local` berbagi Postgres
       yang sama dengan tumpukan pengembangan sementara `MASTER_KEY`-nya
       berbeda. Tetapi bentuk kegagalannya sama persis dengan yang muncul dari
       rotasi kunci yang belum tuntas atau pemulihan sebagian — keduanya
       keadaan yang wajar terjadi di produksi.

       ── DAN TIDAK BOLEH DITELAN DIAM-DIAM ───────────────────────────────

       Melewatinya tanpa jejak menukar satu kegagalan berisik dengan kegagalan
       senyap: kunci yang benar-benar salah konfigurasi akan terlihat persis
       seperti "tidak ada yang jatuh tempo". Jadi barisnya dilewati, id-nya
       dikumpulkan, dan pemanggilnya yang mencatatnya.

       Yang dikumpulkan HANYA id pengguna. Bukan cipherteks-nya, dan tentu
       bukan kuncinya.
    */
    let email: string;
    let nama: string;
    try {
      email = decryptColumn(keys, r.emailEncrypted);
      nama = decryptColumn(keys, r.fullNameEncrypted);
    } catch {
      takTerbaca.push(r.userId);
      continue;
    }

    aturan.push({
      id: r.id,
      userId: r.userId,
      email,
      nama,
      judul: r.judul,
      jumlah: r.jumlah,
      nextRunOn: r.nextRunOn,
      endsOn: r.endsOn,
      pausedAt: r.pausedAt,
    });
  }

  return { aturan, takTerbaca };
}
