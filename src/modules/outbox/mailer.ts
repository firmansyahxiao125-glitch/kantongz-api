import type { EmailPayload, OutboxTopic } from './index.js';

/**
 * Penyedia email.
 *
 * Antarmuka ada sejak awal meski implementasi produksinya belum dipilih —
 * menyisipkan SES atau Postmark ke dalam kode yang sudah memanggil `fetch`
 * langsung di lima tempat jauh lebih mahal daripada menyediakan satu batas
 * sekarang.
 */

export interface Mailer {
  send: (message: {
    to: string;
    subject: string;
    text: string;
    /** Diteruskan ke penyedia. Pengiriman at-least-once tanpa ini menghasilkan
     *  email ganda setiap kali penandaan `published_at` gagal. */
    idempotencyKey: string;
  }) => Promise<void>;
}

interface Template {
  subject: string;
  body: (payload: EmailPayload) => string;
}

/**
 * Isi email.
 *
 * Bahasa Indonesia, tanpa merek berlebihan, dan tanpa satu pun tautan. Kode
 * diketik pengguna di aplikasi yang sudah terbuka — email berisi tautan masuk
 * adalah email yang melatih pengguna mengeklik tautan di email keuangan, dan
 * pelatihan itulah yang dimanfaatkan phishing.
 */
const TEMPLATES: Record<OutboxTopic, Template> = {
  'email.verify': {
    subject: 'Kode verifikasi KANTONGZ',
    body: (p) =>
      [
        `Halo${p.name ? ` ${p.name}` : ''},`,
        '',
        `Kode verifikasi akunmu: ${p.code ?? ''}`,
        '',
        'Berlaku 10 menit. Jangan bagikan kode ini kepada siapa pun, termasuk kepada orang yang mengaku dari KANTONGZ.',
        '',
        'Kalau kamu tidak mendaftar, abaikan email ini.',
      ].join('\n'),
  },
  'email.reset': {
    subject: 'Kode pemulihan sandi KANTONGZ',
    body: (p) =>
      [
        `Halo${p.name ? ` ${p.name}` : ''},`,
        '',
        `Kode pemulihan sandimu: ${p.code ?? ''}`,
        '',
        'Berlaku 15 menit. Setelah sandi diganti, seluruh perangkat akan dikeluarkan.',
        '',
        'Kalau kamu tidak meminta pemulihan, abaikan email ini — sandimu tidak berubah.',
      ].join('\n'),
  },
  /*
   * Peringatan masuk dari perangkat baru.
   *
   * Nadanya sengaja TENANG. Sebagian besar penerima memang baru berganti
   * peramban atau ponsel, dan email yang membunyikan alarm setiap kali itu
   * terjadi akan diabaikan justru pada kali yang benar-benar penting.
   *
   * Kalimat terakhir memberi TINDAKAN, bukan sekadar kabar: pemberitahuan
   * keamanan tanpa jalan keluar hanya memindahkan kecemasan ke pembacanya.
   */
  'email.new_device': {
    subject: 'Masuk dari perangkat baru',
    body: (p) =>
      [
        `Halo${p.name ? ` ${p.name}` : ''},`,
        '',
        `Akunmu baru saja dipakai masuk dari perangkat baru${p.device ? `: ${p.device}` : ''}.`,
        '',
        'Kalau itu kamu, tidak ada yang perlu dilakukan.',
        '',
        'Kalau bukan, buka Pusat Keamanan di KANTONGZ dan akhiri sesi perangkat itu —',
        'tokennya langsung dicabut. Sesudah itu ganti kata sandimu.',
      ].join('\n'),
  },
  'email.password_changed': {
    subject: 'Kata sandi KANTONGZ diubah',
    body: (p) =>
      [
        `Halo${p.name ? ` ${p.name}` : ''},`,
        '',
        'Kata sandi akunmu baru saja diubah, dan seluruh perangkat telah dikeluarkan.',
        '',
        'Kalau bukan kamu yang melakukannya, segera pulihkan akses dan hubungi kami.',
      ].join('\n'),
  },
  /*
   * Pengingat jatuh tempo. G1.
   *
   * Kalimat pertamanya memuat SELURUH kabarnya — nama tagihan, nominal, dan
   * kapan. Pengingat dibaca di layar kunci ponsel dan sering tidak dibuka;
   * yang menaruh angkanya di paragraf ketiga sama saja tidak mengirimkannya.
   *
   * Tidak ada tautan, sama seperti seluruh surat lain di berkas ini. Email
   * keuangan yang melatih pembacanya mengeklik tautan adalah pelatihan yang
   * dimanfaatkan phishing — dan pengingat tagihan justru bentuk yang paling
   * sering dipalsukan.
   */
  'email.due_reminder': {
    subject: 'Tagihan akan jatuh tempo',
    body: (p) => {
      const d = p.jatuhTempo;
      const kapan =
        d === undefined
          ? ''
          : d.sisaHari === 0
            ? 'hari ini'
            : d.sisaHari === 1
              ? 'besok'
              : `${String(d.sisaHari)} hari lagi (${tanggalPanjang(d.tanggal)})`;

      return [
        `Halo${p.name ? ` ${p.name}` : ''},`,
        '',
        d === undefined
          ? 'Ada tagihan berulang yang akan segera jatuh tempo.'
          : `${d.judul} sebesar ${rupiah(d.jumlah)} jatuh tempo ${kapan}.`,
        '',
        'KANTONGZ akan mencatatnya sendiri pada tanggal itu. Pengingat ini supaya',
        'saldomu sudah siap sebelum tercatat.',
        '',
        'Kalau tagihan ini sudah tidak berlaku, jeda atau hapus aturannya di',
        'halaman Transaksi Berulang.',
      ].join('\n');
    },
  },
};

/** Rupiah bulat, format Indonesia. Tidak pernah pecahan — §2. */
function rupiah(jumlah: number): string {
  return `Rp ${jumlah.toLocaleString('id-ID')}`;
}

/**
 * `2026-08-17` menjadi `17 Agustus 2026`.
 *
 * Ditulis tangan, bukan lewat `Intl` atas `new Date(...)`: mengurai tanggal
 * kalender menjadi `Date` memaksanya melewati zona waktu, dan tanggal yang
 * sudah benar sebagai kalender tidak punya urusan dengan jam.
 */
const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

function tanggalPanjang(iso: string): string {
  const [tahun, bulan, hari] = iso.split('-');
  const nama = BULAN[Number(bulan) - 1];
  if (tahun === undefined || nama === undefined || hari === undefined) return iso;
  return `${String(Number(hari))} ${nama} ${tahun}`;
}

export function render(topic: OutboxTopic, payload: EmailPayload): {
  subject: string;
  text: string;
} {
  const template = TEMPLATES[topic];
  return { subject: template.subject, text: template.body(payload) };
}

/**
 * Penyedia SMTP lewat HTTP API.
 *
 * Bentuk permintaannya sengaja generik — `to`, `subject`, `text` — karena itulah
 * irisan yang sama di SES, Postmark, Resend, dan Mailgun. Yang berbeda antar
 * penyedia hanya URL dan nama header kuncinya.
 */
export interface HttpMailerConfig {
  endpoint: string;
  apiKey: string;
  from: string;
}

export function createHttpMailer(config: HttpMailerConfig): Mailer {
  return {
    send: async (message) => {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: config.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
        }),
      });

      if (!response.ok) {
        /* Badan respons TIDAK dibaca ke dalam pesan galat: sebagian penyedia
           menggemakan kembali permintaannya, dan permintaannya memuat kode
           verifikasi yang lalu berakhir di kolom `last_error`. */
        throw new Error(`penyedia email menolak: HTTP ${String(response.status)}`);
      }
    },
  };
}
