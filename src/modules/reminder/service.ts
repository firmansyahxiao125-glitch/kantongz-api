import type { KeyProvider } from '../../platform/crypto/index.js';
import type { Database } from '../../platform/db/client.js';
import { localNoon, toDateString, DEFAULT_TIMEZONE } from '../ledger/periods.js';
import { enqueue } from '../outbox/index.js';
import { aturanMendekatiJatuhTempo } from './repository.js';
import { rencanakanPengingat, UFUK_HARI } from './rencana.js';

/**
 * Pemindai pengingat jatuh tempo. G1.
 *
 * ── DI MANA IDEMPOTENSINYA SEBENARNYA BERADA ───────────────────────────
 *
 * Tidak di sini. Fungsi ini boleh dipanggil seratus kali sedetik oleh sepuluh
 * instans sekaligus, dan yang mencegah email ganda adalah satu indeks unik di
 * `outbox.idempotency_key` ditambah `ON CONFLICT DO NOTHING` di `enqueue`.
 *
 * Itu disengaja. Idempotensi yang bersandar pada "periksa dulu, baru tulis"
 * benar hanya sampai dua putaran memeriksa pada milidetik yang sama — dan
 * itulah persis yang terjadi pada penyebaran bergulir, saat instans lama dan
 * baru hidup berdampingan beberapa detik. Basis data adalah satu-satunya
 * tempat yang dapat menengahi perlombaan itu.
 *
 * Perencananya menentukan kunci mana yang muncul; basis data menentukan siapa
 * yang menang. Tidak ada lapisan ketiga, dan tidak perlu.
 *
 * ── TIDAK ADA TABEL `reminders` ────────────────────────────────────────
 *
 * Sempat saya rancang: satu tabel dengan indeks unik `(rule_id, due_on)`,
 * meniru `recurring_runs`. Ia tidak menambah satu pun jaminan di atas yang
 * sudah diberikan indeks unik outbox, dan ia menambah satu migrasi, satu
 * tabel yang tumbuh selamanya, serta satu tempat baru yang bisa tidak sinkron
 * dengan antrean yang sebenarnya mengirim. Outbox SUDAH catatan "apa yang
 * pernah dikirim"; menyalinnya hanya membuat dua kebenaran.
 */

export interface PengingatDeps {
  db: Database;
  keys: KeyProvider;
}

export interface HasilPindai {
  /** Aturan yang lolos penyaringan kasar basis data. */
  diperiksa: number;
  /** Yang menurut perencana pantas diingatkan — termasuk yang sudah pernah. */
  layak: number;
  /** Yang BARU: email yang benar-benar dihasilkan putaran ini. */
  diantrekan: number;
  /**
   * Id pengguna yang barisnya tidak dapat didekripsi, dilewati putaran ini.
   *
   * Bukan nol berarti ada baris yang disandikan kunci yang berbeda dari yang
   * dipakai proses ini. Selama rotasi kunci itu wajar dan sementara; di luar
   * rotasi ia berarti salah konfigurasi, dan harus terlihat.
   */
  takTerbaca: string[];
}

/**
 * Satu putaran pemindaian.
 *
 * @param sekarang Disuntikkan, tidak dibaca dari jam. Putaran yang memanggil
 *                 `new Date()` sendiri tidak dapat diuji tanpa memalsukan jam
 *                 seluruh proses.
 */
export async function pindaiPengingat(
  deps: PengingatDeps,
  sekarang: Date,
  ufuk: number = UFUK_HARI,
  timeZone: string = DEFAULT_TIMEZONE,
): Promise<HasilPindai> {
  const hariIni = toDateString(sekarang, timeZone);

  /* Jendela dilebihkan sehari di kedua ujung; perencana yang menyaring
     tepatnya. Lihat alasannya di `repository.ts`. */
  const dari = geser(hariIni, -1);
  const sampai = geser(hariIni, ufuk + 1);

  const { aturan, takTerbaca } = await aturanMendekatiJatuhTempo(deps.db, deps.keys, dari, sampai);
  const rencana = rencanakanPengingat(aturan, sekarang, ufuk, timeZone);

  let diantrekan = 0;
  for (const p of rencana) {
    const baru = await enqueue(deps.db, 'email.due_reminder', p.kunci, {
      to: p.email,
      ...(p.nama === null ? {} : { name: p.nama }),
      jatuhTempo: {
        judul: p.judul,
        jumlah: p.jumlah,
        tanggal: p.jatuhTempo,
        sisaHari: p.sisaHari,
      },
    });
    if (baru) diantrekan += 1;
  }

  return { diperiksa: aturan.length, layak: rencana.length, diantrekan, takTerbaca };
}

/** Menggeser tanggal kalender sekian hari, lewat tengah hari. */
function geser(tanggal: string, hari: number): string {
  const dasar = localNoon(tanggal);
  return toDateString(new Date(dasar.getTime() + hari * 86_400_000));
}
