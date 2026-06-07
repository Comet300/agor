import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { loadConfig } from '../src/config';
import { buildTargets, buildLoggerOptions, hasLoki } from '../src/logging/logger';

describe('logger targets (Loki gating)', () => {
  it('stdout-only when Loki is not configured', () => {
    const cfg = loadConfig({});
    expect(hasLoki(cfg)).toBe(false);
    const t = buildTargets(cfg);
    expect(t).toHaveLength(1);
    expect(t[0]!.target).toBe('pino/file');
  });

  it('adds a Loki target when all three creds are set', () => {
    const cfg = loadConfig({
      LOKI_URL: 'https://logs-prod-039.grafana.net',
      LOKI_USER: '1640288',
      LOKI_TOKEN: 'glc_write',
      LOG_SERVICE: 'agor',
      LOG_ENV: 'pi',
    });
    expect(hasLoki(cfg)).toBe(true);
    const targets = buildTargets(cfg);
    expect(targets).toHaveLength(2);
    const loki = targets.find((x) => x.target === 'pino-loki')!;
    const o = loki.options as Record<string, unknown>;
    expect(o.host).toBe('https://logs-prod-039.grafana.net');
    expect(o.basicAuth).toEqual({ username: '1640288', password: 'glc_write' });
    expect(o.labels).toEqual({ service: 'agor', env: 'pi' });
    expect(o.batching).toBe(true);
  });

  it('requires ALL three creds (a missing token => stdout only)', () => {
    const cfg = loadConfig({ LOKI_URL: 'https://x', LOKI_USER: '1', LOKI_TOKEN: '' });
    expect(hasLoki(cfg)).toBe(false);
    expect(buildTargets(cfg)).toHaveLength(1);
  });
});

describe('logger options', () => {
  it('child carries service + component and redacts secrets', () => {
    const cfg = loadConfig({ LOG_SERVICE: 'agor', LOG_LEVEL: 'info' });
    const lines: string[] = [];
    const sink = { write: (s: string) => void lines.push(s) };
    const logger = pino(buildLoggerOptions(cfg), sink as unknown as pino.DestinationStream);

    logger.child({ component: 'cycle' }).info(
      { monitorId: 1, vendor: 'OLX', ok: true, token: 'super-secret-bot-token' },
      'poll',
    );

    const rec = JSON.parse(lines[0]!);
    expect(rec.service).toBe('agor');
    expect(rec.component).toBe('cycle');
    expect(rec.monitorId).toBe(1);
    expect(rec.msg).toBe('poll');
    expect(rec.token).toBe('[redacted]'); // a secret must never reach the logs
  });

  it('respects the configured level (warn suppresses info)', () => {
    const cfg = loadConfig({ LOG_LEVEL: 'warn' });
    const lines: string[] = [];
    const sink = { write: (s: string) => void lines.push(s) };
    const logger = pino(buildLoggerOptions(cfg), sink as unknown as pino.DestinationStream);
    logger.info('quiet');
    logger.warn('loud');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('loud');
  });
});
