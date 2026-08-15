import { describe, expect, it } from 'vitest';

import { parseReceipt } from '../parser.js';
import { korpus } from './korpus.js';

/**
 * F5 — akurasi pengurai struk, DIUKUR bukan dikira.
 *
 * ── MENGAPA ANGKA, BUKAN "SEPERTINYA BEKERJA" ──────────────────────────
 *
 * Uji satuan pengurai menjawab "apakah kasus ini benar". Tidak satu pun
 * menjawab "seberapa sering ia benar" — dan itu pertanyaan yang sebenarnya
 * ditanyakan pengguna ketika ia memutuskan mempercayai angka yang muncul di
 * layar.
 *
 * Berkas ini menjawabnya dengan satu angka, terhadap 48 struk yang bentuknya
 * menyerupai struk Indonesia sungguhan dan sebagiannya sengaja dikotori
 * seperti OCR mengotorinya.
 *
 * ── AMBANGNYA DIUKUR LEBIH DULU, BUKAN DITEBAK ─────────────────────────
 *
 * Angka pertama dijalankan tanpa ambang apa pun, lalu ambangnya dipasang
 * sedikit di bawahnya. Ambang yang ditebak lebih dulu selalu salah ke salah
 * satu arah: terlalu longgar dan ia tidak menjaga apa pun, terlalu ketat dan
 * ia merah sejak hari pertama lalu dimatikan orang.
 */

const KORPUS = korpus();

/**
 * Ambang total: 100%.
 *
 * Total adalah SATU-SATUNYA angka yang benar-benar dipakai — ia yang mengisi
 * formulir dan ia yang akhirnya masuk pembukuan. Merchant dan tanggal
 * membantu; total yang salah menulis angka yang salah ke uang seseorang.
 *
 * Diukur pada jalanan pertama: 48 dari 48 (100%). Karena derau sengaja tidak
 * pernah menyentuh digit — pengurai tidak boleh diminta meramal angka yang
 * sudah hilang — 100% adalah ambang yang jujur di sini, bukan ambisi.
 */
const AMBANG_TOTAL = 1.0;

/**
 * Ambang merchant: 0,90 — DIUKUR, lalu diberi sisa.
 *
 * Jalanan pertama menghasilkan 45 dari 48 (93,8%). Angka pertama yang saya
 * tulis di sini adalah 0,75, dan itu salah: ambang delapan belas poin di
 * bawah hasil ukur tidak menjaga apa pun — pengurai boleh memburuk seperempat
 * dan gerbangnya tetap hijau.
 *
 * 0,90 mengikat: ia memberi ruang untuk satu struk tambahan meleset, dan
 * merah begitu penguraian merchant benar-benar mundur.
 *
 * Lebih rendah daripada ambang total dengan sengaja, dan sebabnya ada di
 * datanya sendiri: nama merchant adalah baris yang PALING dirusak derau,
 * karena ia satu-satunya baris yang seluruhnya huruf. "INDOMARET" pada derau
 * 12% dapat menjadi "1ND0MARET", dan menuntut pengurai memulihkannya berarti
 * menuntutnya mengenali merchant yang tidak pernah ia lihat.
 *
 * Ketiga yang meleset disebut supaya tidak hilang: INDOMARET (derau 20%),
 * Apotek Sehat (12%), Toko Bangunan Jaya (20%).
 */
const AMBANG_MERCHANT = 0.9;

interface Skor {
  benar: number;
  total: number;
  rasio: number;
  meleset: string[];
}

function ukur(nilai: (s: (typeof KORPUS)[number]) => boolean): Skor {
  const meleset: string[] = [];
  let benar = 0;
  for (const s of KORPUS) {
    if (nilai(s)) benar += 1;
    else meleset.push(s.nama);
  }
  return { benar, total: KORPUS.length, rasio: benar / KORPUS.length, meleset };
}

describe('F5 · akurasi pengurai struk', () => {
  it('korpusnya benar-benar berisi minimal 40 struk', () => {
    /* Angka di ROADMAP, dijaga di sini. Korpus yang menyusut diam-diam
       membuat akurasinya naik tanpa penguraiannya membaik sedikit pun. */
    expect(KORPUS.length).toBeGreaterThanOrEqual(40);
  });

  it('korpusnya benar-benar KOTOR, bukan bersih semua', () => {
    /* Struk bersih tidak menguji apa pun: pengurai apa pun lulus di atasnya.
       Kalau derau berhenti bekerja, angka akurasinya akan melonjak dan
       terlihat seperti kabar baik. */
    const kotor = KORPUS.filter((s) => /[^\d\s]0|[^\d\s]1|[^\d\s]5/.test(s.teks));
    expect(kotor.length).toBeGreaterThan(10);
  });

  it(`TOTAL terbaca benar pada >= ${String(AMBANG_TOTAL * 100)}%`, () => {
    const skor = ukur((s) => parseReceipt(s.teks).total === s.benar.total);

    /* Yang meleset disebut namanya. Angka akurasi tanpa daftar kegagalan
       tidak dapat ditindaklanjuti — tidak ada yang tahu harus memperbaiki
       apa. */
    expect(skor.meleset, `meleset: ${skor.meleset.join(', ')}`).toEqual([]);
    expect(skor.rasio).toBeGreaterThanOrEqual(AMBANG_TOTAL);
  });

  it(`MERCHANT terbaca benar pada >= ${String(AMBANG_MERCHANT * 100)}%`, () => {
    const skor = ukur((s) => {
      const terbaca = parseReceipt(s.teks).merchant;
      if (terbaca === null || s.benar.merchant === null) return false;
      /* Dibandingkan tanpa peduli besar-kecil huruf dan spasi: struk termal
         mencetak nama dengan spasi yang tidak konsisten, dan itu bukan
         kesalahan penguraian. */
      const rapi = (x: string): string => x.toLowerCase().replace(/\s+/g, '');
      return rapi(terbaca) === rapi(s.benar.merchant);
    });

    expect(
      skor.rasio,
      `${String(skor.benar)}/${String(skor.total)}; meleset: ${skor.meleset.slice(0, 6).join(', ')}`,
    ).toBeGreaterThanOrEqual(AMBANG_MERCHANT);
  });

  it('TIDAK PERNAH mengarang total pada struk yang tidak punya total', () => {
    /* Kegagalan yang paling berbahaya bukan salah membaca melainkan
       MENGARANG: angka yang muncul percaya diri di formulir, dari struk yang
       sebenarnya tidak menyebutkan total sama sekali. */
    const tanpaTotal = [
      'INDOMARET\nJl. Contoh No. 1\nBeras 5kg    68.000\nTelur 1kg    28.000',
      'Struk parkir\nMasuk 09:00\nKeluar 11:00',
      '',
    ];

    for (const teks of tanpaTotal) {
      expect(parseReceipt(teks).total, teks.slice(0, 20)).toBeNull();
    }
  });

  it('keyakinannya TURUN ketika totalnya tidak ditemukan', () => {
    const jelas = parseReceipt(KORPUS[0]?.teks ?? '');
    const tak = parseReceipt('Struk parkir\nMasuk 09:00');

    expect(jelas.confidence).not.toBe('rendah');
    expect(tak.confidence).toBe('rendah');
  });
});
