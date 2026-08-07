import { pino, type DestinationStream, type Logger } from 'pino';

import type { Config } from '../../config/index.js';

/**
 * Log terstruktur. Satu objek JSON per baris, tanpa kecuali.
 *
 * `redact` bukan kenyamanan melainkan kontrol. Sandi, token, dan kode
 * verifikasi tidak boleh muncul di log meski seseorang keliru meneruskan
 * seluruh badan permintaan — dan seseorang, suatu hari, akan melakukannya.
 */
const REDACTED = [
  'password',
  'newPassword',
  'code',
  'ticket',
  'accessToken',
  'refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.refreshToken',
] as const;

/**
 * Tujuan tulis. Dibiarkan terbuka HANYA supaya penyensoran dapat diuji.
 *
 * Penyensoran adalah kontrol keamanan, dan kontrol keamanan yang tidak diuji
 * adalah kontrol yang diyakini ada. Menguji daftar `redact` tanpa menangkap
 * keluaran sungguhannya berarti menguji bahwa daftarnya tertulis — bukan bahwa
 * ia bekerja.
 *
 * Produksi tidak pernah meneruskan argumen ini, dan pino menulis ke stdout.
 */
export function createLogger(config: Config, destination?: DestinationStream): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: { paths: [...REDACTED], censor: '[REDACTED]' },
    base: { service: 'kantongz-api', env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
      : {}),
  }, destination);
}

export type { Logger };
