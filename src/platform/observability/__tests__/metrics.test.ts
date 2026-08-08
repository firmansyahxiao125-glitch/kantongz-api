import { describe, expect, it, beforeEach } from 'vitest';

import { recordRequest, renderMetrics, requestEnded, requestStarted, resetMetrics } from '../metrics.js';

/**
 * Metrik dalam format eksposisi Prometheus.
 *
 * Yang diuji di sini adalah INVARIAN formatnya, bukan angkanya. Histogram yang
 * embernya tidak monoton atau yang `+Inf`-nya tidak sama dengan `_count`
 * ditolak Prometheus sebagai cacat — dan penolakannya terjadi di sisi scraper,
 * jauh dari kode yang menyebabkannya.
 */
describe('eksposisi Prometheus', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('menghitung permintaan per metode, rute, dan status', () => {
    recordRequest('GET', '/v1/dashboard', 200, 0.01);
    recordRequest('GET', '/v1/dashboard', 200, 0.02);
    recordRequest('GET', '/v1/dashboard', 401, 0.001);

    const out = renderMetrics();
    expect(out).toContain('kantongz_http_requests_total{method="GET",route="/v1/dashboard",status="200"} 2');
    expect(out).toContain('kantongz_http_requests_total{method="GET",route="/v1/dashboard",status="401"} 1');
  });

  it('ember histogram kumulatif dan monoton, dan +Inf sama dengan _count', () => {
    for (const d of [0.0005, 0.003, 0.03, 0.3, 3]) recordRequest('GET', '/v1/x', 200, d);

    const out = renderMetrics();
    const buckets = [...out.matchAll(/_bucket\{method="GET",route="\/v1\/x",le="([^"]+)"\} (\d+)/g)]
      .map(([, , v]) => Number(v));

    /* Kumulatif: setiap ember memuat seluruh isi ember sebelumnya. */
    for (let i = 0; i < buckets.length - 1; i += 1) {
      expect(buckets[i]).toBeLessThanOrEqual(buckets[i + 1] ?? 0);
    }

    const count = Number(/_count\{method="GET",route="\/v1\/x"\} (\d+)/.exec(out)?.[1]);
    expect(buckets.at(-1)).toBe(count);
    expect(count).toBe(5);
  });

  it('melarikan tanda kutip di label supaya parser tidak rusak', () => {
    recordRequest('GET', '/v1/a"b', 200, 0.01);
    expect(renderMetrics()).toContain('route="/v1/a\\"b"');
  });

  it('mencatat permintaan yang sedang diproses', () => {
    requestStarted();
    requestStarted();
    expect(renderMetrics()).toContain('kantongz_http_requests_in_flight 2');
    requestEnded();
    expect(renderMetrics()).toContain('kantongz_http_requests_in_flight 1');
  });

  it('menyertakan metrik proses', () => {
    const out = renderMetrics();
    for (const m of [
      'kantongz_process_resident_memory_bytes',
      'kantongz_process_heap_used_bytes',
      'kantongz_process_cpu_seconds_total',
      'kantongz_process_uptime_seconds',
    ]) {
      expect(out).toContain(m);
    }
  });
});
