import { createConnection, type Socket } from 'node:net';
import { connect as createTlsConnection, type TLSSocket } from 'node:tls';

import type { Mailer } from './mailer.js';

/**
 * Pengirim SMTP. Penyedia email BAWAAN.
 *
 * SMTP dan bukan API berbayar: setiap penyedia email mendukungnya, Mailpit
 * menyediakannya secara lokal tanpa akun apa pun, dan Gmail menerimanya dengan
 * sandi aplikasi. Tidak ada langganan yang perlu dibayar untuk mengirim satu
 * email verifikasi.
 *
 * Ditulis langsung di atas soket dan bukan lewat pustaka: yang dibutuhkan
 * adalah tujuh perintah SMTP, dan pustaka yang membawa parser MIME lengkap
 * beserta dua puluh dependensi transitif adalah permukaan serangan yang tidak
 * sebanding dengan penghematan seratus baris.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** Alamat pengirim. Wajib — SMTP menolak amplop tanpa pengirim. */
  from: string;
  /** Kosongkan untuk server lokal seperti Mailpit yang tidak menuntut sandi. */
  user?: string | undefined;
  password?: string | undefined;
  /** `true` untuk port 465 (TLS langsung). Port 587 memakai STARTTLS. */
  secure: boolean;
  timeoutMs: number;
}

/** Jawaban SMTP: kode tiga digit lalu teks. */
interface Reply {
  code: number;
  text: string;
}

/**
 * Percakapan SMTP di atas satu soket.
 *
 * Dibungkus kelas karena protokolnya berkeadaan: setiap perintah menunggu
 * jawabannya sendiri, dan mengirim perintah berikutnya sebelum jawaban tiba
 * membuat server memutus sambungan tanpa penjelasan.
 */
class SmtpSession {
  private buffer = '';
  private pending: ((reply: Reply) => void) | null = null;
  private failed: ((error: Error) => void) | null = null;

  constructor(private socket: Socket | TLSSocket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    socket.on('error', (error: unknown) => {
      this.failed?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  /**
   * Jawaban SMTP bisa berbaris banyak: `250-EXTENSION` lalu `250 SELESAI`.
   * Spasi setelah kode menandai baris terakhir, dan tanda hubung menandai masih
   * ada lanjutan.
   */
  private drain(): void {
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end === -1) return;

      const line = this.buffer.slice(0, end);
      const complete = line.length >= 4 && line[3] === ' ';
      if (!complete) {
        this.buffer = this.buffer.slice(end + 2);
        continue;
      }

      this.buffer = this.buffer.slice(end + 2);
      const resolve = this.pending;
      this.pending = null;
      resolve?.({ code: Number(line.slice(0, 3)), text: line.slice(4) });
      return;
    }
  }

  private expect(): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      this.pending = resolve;
      this.failed = reject;
    });
  }

  async command(line: string, ...accepted: number[]): Promise<Reply> {
    this.socket.write(`${line}\r\n`);
    const reply = await this.expect();

    if (!accepted.includes(reply.code)) {
      /* Teks jawaban server TIDAK ikut: sebagian server menggemakan kembali
         perintahnya, dan perintahnya memuat alamat penerima. */
      throw new Error(`SMTP menolak: ${String(reply.code)}`);
    }
    return reply;
  }

  greeting(): Promise<Reply> {
    return this.expect();
  }

  upgrade(host: string): SmtpSession {
    const tls = createTlsConnection({ socket: this.socket, servername: host });
    return new SmtpSession(tls);
  }

  close(): void {
    this.socket.end();
  }
}

/**
 * Header dan badan email.
 *
 * Baris yang diawali titik digandakan — titik tunggal di awal baris MENGAKHIRI
 * badan pesan menurut RFC 5321, dan catatan pengguna yang kebetulan dimulai
 * dengan titik akan memotong emailnya di tengah.
 */
function encodeBody(from: string, to: string, subject: string, text: string): string {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    /* Base64 supaya subjek berbahasa Indonesia dengan karakter non-ASCII tidak
       rusak. RFC 2047. */
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    `Date: ${new Date().toUTCString()}`,
  ].join('\r\n');

  const body = text
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');

  return `${headers}\r\n\r\n${body}\r\n.`;
}

export function createSmtpMailer(config: SmtpConfig): Mailer {
  return {
    send: async (message) => {
      const socket = config.secure
        ? createTlsConnection({ host: config.host, port: config.port, servername: config.host })
        : createConnection({ host: config.host, port: config.port });

      socket.setTimeout(config.timeoutMs, () => {
        socket.destroy(new Error('SMTP tidak menjawab dalam batas waktu'));
      });

      let session = new SmtpSession(socket);

      try {
        await session.greeting();
        const hello = await session.command(`EHLO kantongz`, 250);

        /* STARTTLS bila server menawarkannya dan sambungannya belum terenkripsi.
           Sandi yang dikirim di atas sambungan polos adalah sandi yang bocor. */
        if (!config.secure && hello.text.length >= 0) {
          const supportsTls = hello.text.toUpperCase().includes('STARTTLS');
          if (supportsTls) {
            await session.command('STARTTLS', 220);
            session = session.upgrade(config.host);
            await session.command(`EHLO kantongz`, 250);
          }
        }

        if (config.user && config.password) {
          /* AUTH PLAIN: satu baris base64 berisi \0user\0password. */
          const credential = Buffer.from(`\0${config.user}\0${config.password}`, 'utf8').toString(
            'base64',
          );
          await session.command(`AUTH PLAIN ${credential}`, 235);
        }

        await session.command(`MAIL FROM:<${config.from}>`, 250);
        await session.command(`RCPT TO:<${message.to}>`, 250, 251);
        await session.command('DATA', 354);
        await session.command(
          encodeBody(config.from, message.to, message.subject, message.text),
          250,
        );
        await session.command('QUIT', 221);
      } finally {
        session.close();
      }
    },
  };
}
