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
  FAILURE_ALERT_THRESHOLD: z.coerce.number().int().positive().default(3),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
  // Grafana Cloud Loki log shipping (all three required to ship; else stdout-only).
  LOKI_URL: z.string().optional(),
  LOKI_USER: z.string().optional(),
  LOKI_TOKEN: z.string().optional(),
  LOG_SERVICE: z.string().default('agor'),
  LOG_ENV: z.string().default('prod'),
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
  /** Consecutive unhealthy cycles before the chat is told a watch is failing. */
  failureAlertThreshold: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  /** Grafana Cloud Loki: push host (e.g. https://logs-prod-039.grafana.net). */
  lokiUrl?: string;
  /** Loki tenant/instance id (Basic-auth username). */
  lokiUser?: string;
  /** Loki write token (Basic-auth password; needs logs:write scope). */
  lokiToken?: string;
  /** Log label: service name. */
  logService: string;
  /** Log label: environment (e.g. pi, prod). */
  logEnv: string;
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
    failureAlertThreshold: parsed.FAILURE_ALERT_THRESHOLD,
    logLevel: parsed.LOG_LEVEL,
    lokiUrl: parsed.LOKI_URL || undefined,
    lokiUser: parsed.LOKI_USER || undefined,
    lokiToken: parsed.LOKI_TOKEN || undefined,
    logService: parsed.LOG_SERVICE,
    logEnv: parsed.LOG_ENV,
    webhookUrl: parsed.WEBHOOK_URL || undefined,
    webhookPort: parsed.WEBHOOK_PORT,
    webhookSecret: parsed.WEBHOOK_SECRET || undefined,
  };
}
