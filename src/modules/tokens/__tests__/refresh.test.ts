import { describe, expect, it } from 'vitest';

import {
  ABSOLUTE_SESSION_MS,
  GRACE_WINDOW_MS,
  REFRESH_TTL_MS,
  decideRotation,
  hashRefreshToken,
  refreshExpiryFor,
  type RotationInput,
  type SessionState,
  type StoredToken,
} from '../refresh.js';

const NOW = 1_800_000_000_000;

const session = (over: Partial<SessionState> = {}): SessionState => ({
  closedAt: null,
  absoluteExpiresAt: NOW + ABSOLUTE_SESSION_MS,
  deviceId: 'dev_1',
  ...over,
});

const token = (over: Partial<StoredToken> = {}): StoredToken => ({
  sessionId: 'ses_1',
  generation: 1,
  expiresAt: NOW + REFRESH_TTL_MS,
  rotatedAt: null,
  revokedAt: null,
  ...over,
});

const input = (over: Partial<RotationInput> = {}): RotationInput => ({
  token: token(),
  session: session(),
  requestDeviceId: 'dev_1',
  cacheHealthy: true,
  graceHit: false,
  now: NOW,
  ...over,
});

describe('rotasi normal', () => {
  it('merotasi token yang segar', () => {
    expect(decideRotation(input())).toEqual({ kind: 'rotate' });
  });

  it('menolak token yang tidak dikenal tanpa mencabut apa pun', () => {
    expect(decideRotation(input({ token: null }))).toEqual({ kind: 'reject', reason: 'unknown' });
  });

  it('menolak token yang kedaluwarsa', () => {
    expect(decideRotation(input({ token: token({ expiresAt: NOW - 1 }) }))).toEqual({
      kind: 'reject',
      reason: 'expired',
    });
  });
});

describe('deteksi pemakaian ulang', () => {
  it('mencabut keluarga saat token yang sudah dicabut dipakai', () => {
    expect(decideRotation(input({ token: token({ revokedAt: NOW - 5000 }) }))).toEqual({
      kind: 'revoke_family',
      reason: 'reuse',
    });
  });

  it('mencabut keluarga saat token dipakai setelah jendela grace lewat', () => {
    const lama = token({ rotatedAt: NOW - GRACE_WINDOW_MS - 1 });
    expect(decideRotation(input({ token: lama }))).toEqual({
      kind: 'revoke_family',
      reason: 'reuse',
    });
  });

  it('mencabut keluarga di dalam grace bila entri cache tidak ada', () => {
    const baru = token({ rotatedAt: NOW - 1000 });
    expect(decideRotation(input({ token: baru, graceHit: false }))).toEqual({
      kind: 'revoke_family',
      reason: 'reuse',
    });
  });
});

describe('jendela toleransi', () => {
  it('memutar ulang respons saat entri cache ada', () => {
    const baru = token({ rotatedAt: NOW - 1000 });
    expect(decideRotation(input({ token: baru, graceHit: true }))).toEqual({ kind: 'replay' });
  });

  /**
   * Inti temuan audit HIGH-7. Redis yang jatuh TIDAK boleh mencabut keluarga
   * token — satu gangguan satu menit akan mengeluarkan seluruh pengguna aktif.
   */
  it('tidak mencabut apa pun saat cache tidak sehat', () => {
    const baru = token({ rotatedAt: NOW - 1000 });
    expect(decideRotation(input({ token: baru, cacheHealthy: false, graceHit: false }))).toEqual({
      kind: 'rotate_degraded',
    });
  });

  it('deteksi di luar jendela tetap berjalan meski cache mati', () => {
    const lama = token({ rotatedAt: NOW - GRACE_WINDOW_MS - 1 });
    expect(decideRotation(input({ token: lama, cacheHealthy: false }))).toEqual({
      kind: 'revoke_family',
      reason: 'reuse',
    });
  });

  it('token yang dicabut tetap terdeteksi meski cache mati', () => {
    expect(
      decideRotation(input({ token: token({ revokedAt: NOW - 1 }), cacheHealthy: false })),
    ).toEqual({ kind: 'revoke_family', reason: 'reuse' });
  });
});

describe('pengikatan perangkat', () => {
  it('mencabut keluarga saat perangkat tidak cocok', () => {
    expect(decideRotation(input({ requestDeviceId: 'dev_lain' }))).toEqual({
      kind: 'revoke_family',
      reason: 'device_mismatch',
    });
  });

  /* Urutan pemeriksaan adalah aturannya: perangkat diperiksa sebelum rotasi,
     supaya token curian dari perangkat lain tidak lolos lewat jendela grace. */
  it('perangkat diperiksa lebih dulu daripada jendela grace', () => {
    const baru = token({ rotatedAt: NOW - 1000 });
    expect(
      decideRotation(input({ token: baru, graceHit: true, requestDeviceId: 'dev_lain' })),
    ).toEqual({ kind: 'revoke_family', reason: 'device_mismatch' });
  });
});

describe('siklus hidup sesi', () => {
  it('menolak sesi yang sudah ditutup', () => {
    expect(decideRotation(input({ session: session({ closedAt: NOW - 1 }) }))).toEqual({
      kind: 'reject',
      reason: 'session_closed',
    });
  });

  it('menolak sesi yang melewati batas mutlak', () => {
    expect(decideRotation(input({ session: session({ absoluteExpiresAt: NOW }) }))).toEqual({
      kind: 'reject',
      reason: 'session_absolute',
    });
  });
});

describe('masa berlaku token hasil rotasi', () => {
  it('30 hari saat batas mutlak masih jauh', () => {
    expect(refreshExpiryFor(session(), NOW)).toBe(NOW + REFRESH_TTL_MS);
  });

  /* §5.1 — tanpa batas kedua, rotasi berulang membuat sesi hidup selamanya
     dan batas mutlak 90 hari tidak pernah tercapai. */
  it('dipotong batas mutlak sesi saat sesi hampir berakhir', () => {
    const hampirHabis = session({ absoluteExpiresAt: NOW + 1000 });
    expect(refreshExpiryFor(hampirHabis, NOW)).toBe(NOW + 1000);
  });
});

describe('hash token', () => {
  it('deterministik dan berbeda antar token', () => {
    expect(hashRefreshToken('a').equals(hashRefreshToken('a'))).toBe(true);
    expect(hashRefreshToken('a').equals(hashRefreshToken('b'))).toBe(false);
    expect(hashRefreshToken('a')).toHaveLength(32);
  });
});
