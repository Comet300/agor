/**
 * Environment-driven runtime configuration, validated with zod.
 * Missing BOT_TOKEN / PROXY_URLS is tolerated (fixture / test mode).
 */
import { z } from 'zod';

const csv = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const EnvSchema = z.object({
  BOT_TOKEN: z.string().optional(),
  DATABASE_PATH: z.string().default('./agor.db'),
  PROXY_URLS: z.string().optional(),
  DEFAULT_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  OOS_FAST_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
  DEDUP_WINDOW_MS: z.coerce.number().int().positive().default(86_400_000),
  BENCHMARK_MIN_SAMPLE: z.coerce.number().int().positive().default(4),
  PROXY_BENCH_COOLDOWN_MS: z.coerce.number().int().positive().default(300_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Webhook mode (production): when WEBHOOK_URL is set the bot serves updates
  // from an HTTP listener instead of long-polling.
  WEBHOOK_URL: z.string().optional(),
  WEBHOOK_PORT: z.coerce.number().int().positive().default(8443),
  WEBHOOK_SECRET: z.string().optional(),
});

export interface AppConfig {
  botToken?: string;
  databasePath: string;
  proxyUrls: string[];
  defaultCheckIntervalMs: number;
  oosFastIntervalMs: number;
  dedupWindowMs: number;
  benchmarkMinSample: number;
  proxyBenchCooldownMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Public HTTPS URL Telegram posts updates to; absent ⇒ long-polling. */
  webhookUrl?: string;
  /** Local port the webhook HTTP listener binds. */
  webhookPort: number;
  /** Secret-token header enforced on incoming webhook requests. */
  webhookSecret?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    botToken: parsed.BOT_TOKEN || undefined,
    databasePath: parsed.DATABASE_PATH,
    proxyUrls: csv(parsed.PROXY_URLS),
    defaultCheckIntervalMs: parsed.DEFAULT_CHECK_INTERVAL_MS,
    oosFastIntervalMs: parsed.OOS_FAST_INTERVAL_MS,
    dedupWindowMs: parsed.DEDUP_WINDOW_MS,
    benchmarkMinSample: parsed.BENCHMARK_MIN_SAMPLE,
    proxyBenchCooldownMs: parsed.PROXY_BENCH_COOLDOWN_MS,
    logLevel: parsed.LOG_LEVEL,
    webhookUrl: parsed.WEBHOOK_URL || undefined,
    webhookPort: parsed.WEBHOOK_PORT,
    webhookSecret: parsed.WEBHOOK_SECRET || undefined,
  };
}
