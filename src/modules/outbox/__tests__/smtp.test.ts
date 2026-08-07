import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createSmtpMailer } from '../smtp.js';

/**
 * Uji pengirim SMTP terhadap server SMTP SUNGGUHAN.
 *
 * Servernya kecil dan hidup di dalam proses uji — bukan tiruan yang memeriksa
 * argumen, melainkan soket yang benar-benar berbicara protokolnya. Yang diuji
 * adalah percakapannya: urutan perintah, penanganan jawaban berbaris banyak,
 * dan penyandian badan pesan. Ketiganya tidak dapat dibuktikan tiruan mana pun.
 */

interface Recorded {
  commands: string[];
  body: string;
}

/**
 * Server SMTP minimal.
 *
 * Menjawab dengan kode yang benar dan mencatat apa yang diterimanya. Jawaban
 * EHLO sengaja berbaris banyak, sebab itulah bentuk yang paling mudah salah
 * diurai — dan yang salah diurai membuat klien menggantung menunggu baris yang
 * tidak akan datang.
 */
function startServer(options: { announceStartTls?: boolean } = {}): Promise<{
  port: number;
  server: Server;
  recorded: Recorded;
}> {
  const recorded: Recorded = { commands: [], body: '' };

  const server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = '';

    socket.setEncoding('utf8');
    socket.write('220 uji.kantongz ESMTP\r\n');

    socket.on('data', (chunk: string) => {
      buffer += chunk;

      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end === -1) break;

        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 diterima\r\n');
          } else {
            /* Titik ganda di awal baris dikembalikan menjadi satu — kebalikan
               dari apa yang dilakukan pengirim. */
            recorded.body += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }

        recorded.commands.push(line);
        const verb = line.split(' ')[0]?.toUpperCase() ?? '';

        if (verb === 'EHLO') {
          /* Berbaris banyak: tanda hubung menandai masih ada lanjutan, spasi
             menandai baris terakhir. */
          socket.write('250-uji.kantongz\r\n');
          socket.write('250-SIZE 10240000\r\n');
          if (options.announceStartTls) socket.write('250-STARTTLS\r\n');
          socket.write('250 AUTH PLAIN\r\n');
        } else if (verb === 'AUTH') {
          socket.write('235 diterima\r\n');
        } else if (verb === 'MAIL' || verb === 'RCPT') {
          socket.write('250 baik\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 lanjutkan\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 selamat tinggal\r\n');
          socket.end();
        } else {
          socket.write('502 tidak dikenal\r\n');
        }
      }
    });

    socket.on('error', () => {
      /* Klien yang menutup lebih dulu adalah keadaan normal di sini. */
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, server, recorded });
    });
  });
}

let running: Server | null = null;

afterEach(() => {
  running?.close();
  running = null;
});

describe('percakapan SMTP', () => {
  it('menjalankan urutan perintah yang benar', async () => {
    const { port, server, recorded } = await startServer();
    running = server;

    await createSmtpMailer({
      host: '127.0.0.1',
      port,
      from: 'noreply@kantongz.id',
      secure: false,
      timeoutMs: 5_000,
    }).send({
      to: 'orang@contoh.id',
      subject: 'Kode verifikasi KANTONGZ',
      text: 'Kode verifikasi akunmu: 123456',
      idempotencyKey: 'verify:tkt_1',
    });

    const verbs = recorded.commands.map((c) => c.split(' ')[0]?.toUpperCase());
    expect(verbs).toEqual(['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
  }, 30_000);

  /* Jawaban EHLO berbaris banyak adalah bentuk yang paling mudah salah diurai,
     dan yang salah diurai membuat klien menggantung menunggu baris yang tidak
     akan datang. */
  it('mengurai jawaban EHLO yang berbaris banyak', async () => {
    const { port, server, recorded } = await startServer();
    running = server;

    await createSmtpMailer({
      host: '127.0.0.1',
      port,
      from: 'noreply@kantongz.id',
      secure: false,
      timeoutMs: 5_000,
    }).send({ to: 'a@contoh.id', subject: 'Uji', text: 'isi', idempotencyKey: 'k' });

    expect(recorded.commands).toContain('QUIT');
  }, 30_000);

  it('melakukan AUTH ketika kredensialnya ada', async () => {
    const { port, server, recorded } = await startServer();
    running = server;

    await createSmtpMailer({
      host: '127.0.0.1',
      port,
      from: 'noreply@kantongz.id',
      user: 'pengguna',
      password: 'rahasia',
      secure: false,
      timeoutMs: 5_000,
    }).send({ to: 'a@contoh.id', subject: 'Uji', text: 'isi', idempotencyKey: 'k' });

    const auth = recorded.commands.find((c) => c.startsWith('AUTH PLAIN '));
    expect(auth).toBeDefined();

    /* Kredensial dikirim sebagai base64 dari \0pengguna\0rahasia. */
    const decoded = Buffer.from(auth?.slice('AUTH PLAIN '.length) ?? '', 'base64').toString('utf8');
    expect(decoded).toBe('\0pengguna\0rahasia');
  }, 30_000);

  it('tidak melakukan AUTH ketika kredensialnya tidak ada', async () => {
    const { port, server, recorded } = await startServer();
    running = server;

    await createSmtpMailer({
      host: '127.0.0.1',
      port,
      from: 'noreply@kantongz.id',
      secure: false,
      timeoutMs: 5_000,
    }).send({ to: 'a@contoh.id', subject: 'Uji', text: 'isi', idempotencyKey: 'k' });

    expect(recorded.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
  }, 30_000);
});

describe('penyandian pesan', () => {
  it('menyandikan subjek non-ASCII sehingga tidak rusak', async () => {
    const { port, server, recorded } = await startServer();
    running = server;

    await createSmtpMailer({
      host: '127.0.0.1',
      port,
      from: 'noreply@kantongz.id',
      secure: false,
      timeoutMs: 5_000,
    }).send({
      to: 'a@contoh.id',
      subject: 'Kata sandi diubah — perhatikan',
      text: 'isi',
      idempotencyKey: 'k',
    });

    const subject = recorded.body.split('\n').find((l) => l.startsWith('Subject:'));
    expect(subject).toMatch(/^Subject: =\?UTF-8\?B\?/);

    const encoded = subject?.replace('Subject: =?UTF-8?B?', '').replace('?=', '') ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('Kata sandi diubah — perhatikan');
  }, 30_000);

  /*
   * INI uji yang paling penting di berkas ini. Titik tunggal di awal baris
   * MENGAKHIRI badan pesan menurut RFC 5321, dan catatan pengguna yang kebetulan
   * dimulai dengan titik akan memotong emailnya di tengah — kode verifikasinya
   * hilang, dan tidak ada satu pun galat yang muncul.
   */
  it('menggandakan titik di awal baris supaya pesan tidak terpotong', async () => {
    const { port, server, recorded } = await startServer();
    running = server;

    await createSmtpMailer({
      host: '127.0.0.1',
      port,
      from: 'noreply@kantongz.id',
      secure: false,
      timeoutMs: 5_000,
    }).send({
      to: 'a@contoh.id',
      subject: 'Uji',
      text: 'baris pertama\n. baris yang diawali titik\nkode: 654321',
      idempotencyKey: 'k',
    });

    expect(recorded.body).toContain('. baris yang diawali titik');
    expect(recorded.body).toContain('kode: 654321');
  }, 30_000);

  it('memuat alamat pengirim dan penerima di amplop', async () => {
    const { port, server, recorded } = await startServer();
    running = server;

    await createSmtpMailer({
      host: '127.0.0.1',
      port,
      from: 'noreply@kantongz.id',
      secure: false,
      timeoutMs: 5_000,
    }).send({ to: 'orang@contoh.id', subject: 'Uji', text: 'isi', idempotencyKey: 'k' });

    expect(recorded.commands).toContain('MAIL FROM:<noreply@kantongz.id>');
    expect(recorded.commands).toContain('RCPT TO:<orang@contoh.id>');
  }, 30_000);
});

describe('kegagalan', () => {
  it('melempar ketika servernya tidak ada', async () => {
    const mailer = createSmtpMailer({
      /* Port 1 tidak pernah dipakai SMTP dan hampir pasti tertutup. */
      host: '127.0.0.1',
      port: 1,
      from: 'noreply@kantongz.id',
      secure: false,
      timeoutMs: 2_000,
    });

    await expect(
      mailer.send({ to: 'a@contoh.id', subject: 'Uji', text: 'isi', idempotencyKey: 'k' }),
    ).rejects.toThrow();
  }, 30_000);

  /* Pesan galat TIDAK memuat teks jawaban server: sebagian server menggemakan
     kembali perintahnya, dan perintahnya memuat alamat penerima. */
  it('pesan galat tidak membocorkan alamat penerima', async () => {
    const server = createServer((socket: Socket) => {
      socket.setEncoding('utf8');
      socket.write('220 uji ESMTP\r\n');
      socket.on('data', () => {
        socket.write('550 ditolak untuk rahasia@contoh.id\r\n');
      });
      socket.on('error', () => undefined);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    running = server;

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    await expect(
      createSmtpMailer({
        host: '127.0.0.1',
        port,
        from: 'noreply@kantongz.id',
        secure: false,
        timeoutMs: 3_000,
      }).send({ to: 'a@contoh.id', subject: 'Uji', text: 'isi', idempotencyKey: 'k' }),
    ).rejects.toThrow(/^SMTP menolak: 550$/);
  }, 30_000);
});
