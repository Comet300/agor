import { describe, it, expect } from 'vitest';
import { loadConfig, droppedAdminIds, incompleteLokiKeys } from '../src/config/index';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const cfg = loadConfig({});
    expect(cfg.databasePath).toBe('./agor.db');
    expect(cfg.proxyUrls).toEqual([]);
    expect(cfg.defaultCheckIntervalMs).toBe(21_600_000); // 6h default
    expect(cfg.benchmarkMinSample).toBe(4);
    expect(cfg.botToken).toBeUndefined();
    // Browser fallback is OFF by default so the base install never needs Chromium.
    expect(cfg.enableBrowserFallback).toBe(false);
    expect(cfg.circuitBreakerThreshold).toBe(10);
    expect(cfg.circuitBreakerCooldownMs).toBe(30 * 60_000);
    expect(cfg.backupIntervalMs).toBe(7 * 24 * 60 * 60_000);
    expect(cfg.auditRetentionDays).toBe(365);
    expect(cfg.maxMonitorsPerChat).toBe(50);
    expect(cfg.checkCooldownMs).toBe(10_000);
    expect(cfg.urlRegisterCooldownMs).toBe(5_000);
  });

  it('coerces the runtime-resilience knobs from env', () => {
    const cfg = loadConfig({
      AUDIT_RETENTION_DAYS: '90',
      MAX_MONITORS_PER_CHAT: '25',
      CHECK_COOLDOWN_MS: '3000',
      URL_REGISTER_COOLDOWN_MS: '1500',
    });
    expect(cfg.auditRetentionDays).toBe(90);
    expect(cfg.maxMonitorsPerChat).toBe(25);
    expect(cfg.checkCooldownMs).toBe(3000);
    expect(cfg.urlRegisterCooldownMs).toBe(1500);
  });

  it('enables the browser fallback only when explicitly set to "true"', () => {
    expect(loadConfig({ ENABLE_BROWSER_FALLBACK: 'true' }).enableBrowserFallback).toBe(true);
    expect(loadConfig({ ENABLE_BROWSER_FALLBACK: 'false' }).enableBrowserFallback).toBe(false);
  });

  it('TLS impersonation defaults off, with a default binary name', () => {
    const def = loadConfig({});
    expect(def.enableTlsImpersonation).toBe(false);
    expect(def.curlImpersonatePath).toBe('curl_chrome116');
    const on = loadConfig({ ENABLE_TLS_IMPERSONATION: 'true', CURL_IMPERSONATE_PATH: 'curl_chrome120' });
    expect(on.enableTlsImpersonation).toBe(true);
    expect(on.curlImpersonatePath).toBe('curl_chrome120');
  });

  it('parses ADMIN_CHAT_IDS into a numeric list (empty when unset)', () => {
    expect(loadConfig({}).adminChatIds).toEqual([]);
    expect(loadConfig({ ADMIN_CHAT_IDS: '111, 222 ,333' }).adminChatIds).toEqual([111, 222, 333]);
    // Non-numeric entries are dropped, not coerced to NaN.
    expect(loadConfig({ ADMIN_CHAT_IDS: '111,abc,222' }).adminChatIds).toEqual([111, 222]);
  });

  it('droppedAdminIds surfaces the exact non-numeric ADMIN_CHAT_IDS entries', () => {
    expect(droppedAdminIds({})).toEqual([]);
    expect(droppedAdminIds({ ADMIN_CHAT_IDS: '111,222' })).toEqual([]);
    expect(droppedAdminIds({ ADMIN_CHAT_IDS: '111,abc,222,9x' })).toEqual(['abc', '9x']);
  });

  it('incompleteLokiKeys names missing Loki vars only when partially configured', () => {
    // None set → not partial → no warning.
    expect(incompleteLokiKeys({})).toEqual([]);
    // All three set → complete → no warning.
    expect(incompleteLokiKeys({ LOKI_URL: 'https://x', LOKI_USER: '1', LOKI_TOKEN: 'glc' })).toEqual([]);
    // Two of three → partial → names the missing one.
    expect(incompleteLokiKeys({ LOKI_URL: 'https://x', LOKI_USER: '1' })).toEqual(['LOKI_TOKEN']);
  });

  it('parses proxy CSV and coerces numbers', () => {
    const cfg = loadConfig({
      PROXY_URLS: 'http://a:1, http://b:2 ,',
      BENCHMARK_MIN_SAMPLE: '7',
      BOT_TOKEN: 'abc',
    });
    expect(cfg.proxyUrls).toEqual(['http://a:1', 'http://b:2']);
    expect(cfg.benchmarkMinSample).toBe(7);
    expect(cfg.botToken).toBe('abc');
  });
});
