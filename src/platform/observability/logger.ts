import { pino, type Logger } from 'pino';

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

export function createLogger(config: Config): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: { paths: [...REDACTED], censor: '[REDACTED]' },
    base: { service: 'kantongz-api', env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
      : {}),
  });
}

export type { Logger };
