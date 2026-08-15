import { describe, expect, it } from 'vitest';

import { buangMetadata } from '../metadata.js';

/**
 * Gambarnya DIBANGUN di sini, bukan disimpan sebagai fixture biner.
 *
 * Fixture biner tidak dapat diperiksa dalam diff: tidak ada yang tahu apakah
 * berkas .jpg di repositori benar-benar memuat EXIF yang katanya diuji, atau
 * apakah seseorang menggantinya tiga tahun lalu. Yang dibangun di sini
 * terbaca, dan isinya persis yang dinyatakan.
 */

/** Segmen JPEG: 0xFF, penanda, panjang 16-bit termasuk dirinya, lalu isi. */
function segmen(penanda: number, isi: Buffer): Buffer {
  const kepala = Buffer.alloc(4);
  kepala[0] = 0xff;
  kepala[1] = penanda;
  kepala.writeUInt16BE(isi.length + 2, 2);
  return Buffer.concat([kepala, isi]);
}

/** EXIF sungguhan dimulai dengan "Exif\0\0". Isinya sengaja memuat kata GPS. */
const MUATAN_EXIF = Buffer.concat([
  Buffer.from('Exif\0\0', 'latin1'),
  Buffer.from('II*\0', 'latin1'),
  Buffer.from('GPSLatitude=-6.2088 GPSLongitude=106.8456', 'latin1'),
]);

function jpegBerEXIF(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    segmen(0xe0, Buffer.from('JFIF\0\0\0\0\0\0', 'latin1')), // APP0
    segmen(0xe1, MUATAN_EXIF), // APP1 — EXIF
    segmen(0xed, Buffer.from('Photoshop 3.0\0 penulis: seseorang', 'latin1')), // APP13
    segmen(0xfe, Buffer.from('komentar rahasia', 'latin1')), // COM
    segmen(0xdb, Buffer.alloc(65, 3)), // DQT — harus BERTAHAN
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00]), // SOS
    Buffer.from([0x12, 0x34, 0x56, 0x78]), // data terkompresi
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

function potonganPng(tipe: string, isi: Buffer): Buffer {
  const panjang = Buffer.alloc(4);
  panjang.writeUInt32BE(isi.length);
  /* CRC tidak dihitung: berkas yang diuji tidak pernah didekode, dan yang
     diperiksa hanya potongan mana yang bertahan. */
  return Buffer.concat([panjang, Buffer.from(tipe, 'latin1'), isi, Buffer.alloc(4)]);
}

function pngBerMetadata(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    potonganPng('IHDR', Buffer.alloc(13, 1)),
    potonganPng('eXIf', Buffer.from('GPSLatitude=-6.2088', 'latin1')),
    potonganPng('tEXt', Buffer.from('Author\0seseorang', 'latin1')),
    potonganPng('tIME', Buffer.alloc(7, 2)),
    potonganPng('gAMA', Buffer.alloc(4, 5)), // harus BERTAHAN — mengubah rupa
    potonganPng('IDAT', Buffer.alloc(20, 9)),
    potonganPng('IEND', Buffer.alloc(0)),
  ]);
}

describe('buangMetadata · JPEG', () => {
  it('membuang APP1 dan koordinat GPS di dalamnya', () => {
    const asal = jpegBerEXIF();
    expect(asal.includes(Buffer.from('GPSLatitude'))).toBe(true);

    const hasil = buangMetadata(asal);
    expect(hasil).not.toBeNull();
    expect(hasil?.data.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(hasil?.dibuang).toContain('APP1');
  });

  it('membuang APP13 dan komentar', () => {
    const hasil = buangMetadata(jpegBerEXIF());
    expect(hasil?.data.includes(Buffer.from('penulis'))).toBe(false);
    expect(hasil?.data.includes(Buffer.from('komentar rahasia'))).toBe(false);
    expect(hasil?.dibuang).toContain('APP13');
    expect(hasil?.dibuang).toContain('COM');
  });

  it('MEMPERTAHANKAN APP0, tabel kuantisasi, dan data terkompresi', () => {
    const hasil = buangMetadata(jpegBerEXIF());
    expect(hasil?.dibuang).not.toContain('APP0');
    expect(hasil?.data.includes(Buffer.from('JFIF'))).toBe(true);
    /* SOI + APP0 + DQT + SOS + data + EOI harus utuh; kalau salah satunya
       ikut terbuang, gambarnya tidak lagi dapat didekode. */
    expect(hasil?.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(hasil?.data.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(hasil?.data.includes(Buffer.from([0x12, 0x34, 0x56, 0x78]))).toBe(true);
  });

  it('hasilnya lebih kecil dari asalnya', () => {
    const asal = jpegBerEXIF();
    const hasil = buangMetadata(asal);
    expect(hasil!.data.length).toBeLessThan(asal.length);
  });

  it('gambar yang memang bersih dilewatkan tanpa kehilangan apa pun', () => {
    const bersih = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segmen(0xe0, Buffer.from('JFIF\0', 'latin1')),
      Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00]),
      Buffer.from([0xaa, 0xbb]),
      Buffer.from([0xff, 0xd9]),
    ]);
    const hasil = buangMetadata(bersih);
    expect(hasil?.dibuang).toEqual([]);
    expect(hasil?.data).toEqual(bersih);
  });
});

describe('buangMetadata · PNG', () => {
  it('membuang eXIf, tEXt, dan tIME', () => {
    const asal = pngBerMetadata();
    expect(asal.includes(Buffer.from('GPSLatitude'))).toBe(true);

    const hasil = buangMetadata(asal);
    expect(hasil?.data.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(hasil?.data.includes(Buffer.from('seseorang'))).toBe(false);
    expect(hasil?.dibuang).toEqual(expect.arrayContaining(['eXIf', 'tEXt', 'tIME']));
  });

  it('MEMPERTAHANKAN gAMA — ia mengubah rupa, bukan memuat identitas', () => {
    const hasil = buangMetadata(pngBerMetadata());
    expect(hasil?.dibuang).not.toContain('gAMA');
    expect(hasil?.data.includes(Buffer.from('gAMA'))).toBe(true);
  });

  it('MEMPERTAHANKAN IHDR, IDAT, dan IEND', () => {
    const hasil = buangMetadata(pngBerMetadata());
    for (const wajib of ['IHDR', 'IDAT', 'IEND']) {
      expect(hasil?.data.includes(Buffer.from(wajib)), wajib).toBe(true);
    }
  });
});

describe('buangMetadata · penolakan', () => {
  it('MENOLAK format yang tidak dikenali, bukan melewatkannya', () => {
    /* Melewatkannya berarti berkas yang metadatanya tidak pernah diperiksa
       tetap tersimpan — dan seluruh gunanya modul ini hilang pada berkas
       pertama yang formatnya di luar dugaan. */
    expect(buangMetadata(Buffer.from('GIF89a bukan gambar yang didukung'))).toBeNull();
    expect(buangMetadata(Buffer.alloc(0))).toBeNull();
    /* SOI saja BUKAN JPEG yang sah — tanda pengenalnya tiga byte, karena
       byte ketiga adalah awal penanda pertama. Menuntutnya membuat berkas
       dua byte yang kebetulan berawalan FFD8 tidak lolos sebagai gambar. */
    expect(buangMetadata(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(buangMetadata(Buffer.from([0xff, 0xd8, 0xff]))).not.toBeNull();
  });

  it('tidak menggantung pada berkas JPEG yang terpotong', () => {
    const rusak = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe1, 0x00, 0xff]), // panjang menyebut 255 byte yang tidak ada
    ]);
    const hasil = buangMetadata(rusak);
    expect(hasil).not.toBeNull();
    expect(hasil?.data.length).toBeGreaterThanOrEqual(2);
  });
});
