import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/index';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const cfg = loadConfig({});
    expect(cfg.databasePath).toBe('./agor.db');
    expect(cfg.proxyUrls).toEqual([]);
    expect(cfg.defaultCheckIntervalMs).toBe(600_000);
    expect(cfg.benchmarkMinSample).toBe(4);
    expect(cfg.botToken).toBeUndefined();
    // Browser fallback is OFF by default so the base install never needs Chromium.
    expect(cfg.enableBrowserFallback).toBe(false);
    expect(cfg.circuitBreakerThreshold).toBe(10);
  });

  it('enables the browser fallback only when explicitly set to "true"', () => {
    expect(loadConfig({ ENABLE_BROWSER_FALLBACK: 'true' }).enableBrowserFallback).toBe(true);
    expect(loadConfig({ ENABLE_BROWSER_FALLBACK: 'false' }).enableBrowserFallback).toBe(false);
  });

  it('parses ADMIN_CHAT_IDS into a numeric list (empty when unset)', () => {
    expect(loadConfig({}).adminChatIds).toEqual([]);
    expect(loadConfig({ ADMIN_CHAT_IDS: '111, 222 ,333' }).adminChatIds).toEqual([111, 222, 333]);
    // Non-numeric entries are dropped, not coerced to NaN.
    expect(loadConfig({ ADMIN_CHAT_IDS: '111,abc,222' }).adminChatIds).toEqual([111, 222]);
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
