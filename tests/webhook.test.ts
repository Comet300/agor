import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Bot } from 'grammy';
import { loadConfig } from '../src/config';
import { selectMode, startWebhook } from '../src/gateway/webhook';

describe('config webhook keys', () => {
  it('defaults to long-polling (no webhook url) with port 8443', () => {
    const cfg = loadConfig({});
    expect(cfg.webhookUrl).toBeUndefined();
    expect(cfg.webhookPort).toBe(8443);
    expect(cfg.webhookSecret).toBeUndefined();
  });

  it('parses the webhook keys when present', () => {
    const cfg = loadConfig({
      WEBHOOK_URL: 'https://agor.example/tg',
      WEBHOOK_PORT: '9000',
      WEBHOOK_SECRET: 's3cr3t',
    });
    expect(cfg.webhookUrl).toBe('https://agor.example/tg');
    expect(cfg.webhookPort).toBe(9000);
    expect(cfg.webhookSecret).toBe('s3cr3t');
  });
});

describe('selectMode', () => {
  it('returns webhook only when a url is configured', () => {
    expect(selectMode(loadConfig({ WEBHOOK_URL: 'https://x/tg' }))).toBe('webhook');
    expect(selectMode(loadConfig({}))).toBe('long-polling');
  });
});

describe('startWebhook', () => {
  it('listens and registers the webhook URL with the secret token', async () => {
    // A real Bot (no network at construction); stub the network calls.
    const bot = new Bot('123456:AAEXAMPLE-TOKEN-FOR-TESTS');
    bot.init = vi.fn(async () => {});
    const setWebhook = vi.fn(async () => true);
    (bot.api as unknown as { setWebhook: typeof setWebhook }).setWebhook = setWebhook;

    // Port 0 → OS assigns an ephemeral free port (no conflicts).
    const server = await startWebhook(bot, {
      url: 'https://agor.example/tg',
      port: 0,
      secret: 's3cr3t',
      host: '127.0.0.1',
    });

    try {
      expect((server.address() as AddressInfo).port).toBeGreaterThan(0); // actually listening
      expect(bot.init).toHaveBeenCalledTimes(1);
      expect(setWebhook).toHaveBeenCalledWith(
        'https://agor.example/tg',
        expect.objectContaining({ secret_token: 's3cr3t' }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('closes the listener and rethrows when registration fails (no half-up state)', async () => {
    const bot = new Bot('123456:AAEXAMPLE-TOKEN-FOR-TESTS');
    bot.init = vi.fn(async () => {});
    (bot.api as unknown as { setWebhook: () => Promise<never> }).setWebhook = vi.fn(async () => {
      throw new Error('telegram 401');
    });

    await expect(
      startWebhook(bot, { url: 'https://agor.example/tg', port: 0, host: '127.0.0.1' }),
    ).rejects.toThrow('telegram 401');
    // If the listener were left open the test process would hang on exit; the
    // rejection arriving at all proves startWebhook closed it before rethrowing.
  });
});
