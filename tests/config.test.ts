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
