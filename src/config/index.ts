/**
 * Environment-driven runtime configuration, validated with zod.
 * Missing BOT_TOKEN / PROXY_URLS is tolerated (fixture / test mode).
 */
import { z } from "zod";

const csv = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** CSV of integers; non-numeric entries are dropped (not coerced to NaN). */
const numericCsv = (raw: string | undefined): number[] =>
  csv(raw)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n));

/**
 * The raw ADMIN_CHAT_IDS entries that were dropped as non-integer (e.g. a typo
 * like "9x"). Pure — the boot sequence uses it to WARN, since silently dropping
 * an admin id is a security-relevant misconfiguration. Empty when all parse.
 */
export function droppedAdminIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return csv(env.ADMIN_CHAT_IDS).filter((s) => !Number.isInteger(Number(s)));
}

/**
 * Names of the Loki vars that are MISSING when Loki is partially configured
 * (some set, not all three). Empty when none or all are set — i.e. only returns
 * keys in the silent-degradation case worth warning about.
 */
export function incompleteLokiKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = ['LOKI_URL', 'LOKI_USER', 'LOKI_TOKEN'] as const;
  const set = keys.filter((k) => Boolean(env[k]));
  if (set.length === 0 || set.length === keys.length) return [];
  return keys.filter((k) => !env[k]);
}

const EnvSchema = z.object({
  BOT_TOKEN: z.string().optional(),
  DATABASE_PATH: z.string().default("./agor.db"),
  PROXY_URLS: z.string().optional(),
  // Comma-separated Telegram chat ids that bootstrap as admins (always allowed,
  // can grant/revoke others). Unset ⇒ no admins ⇒ access control is fail-open.
  ADMIN_CHAT_IDS: z.string().optional(),
  DEFAULT_CHECK_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(600_000),
  OOS_FAST_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
  DEDUP_WINDOW_MS: z.coerce.number().int().positive().default(86_400_000),
  BENCHMARK_MIN_SAMPLE: z.coerce.number().int().positive().default(4),
  PROXY_BENCH_COOLDOWN_MS: z.coerce.number().int().positive().default(300_000),
  FAILURE_ALERT_THRESHOLD: z.coerce.number().int().positive().default(3),
  // Hard ceiling on a single monitor's poll cycle (fetch + dispatch). Generous —
  // networks (and the browser fallback) can be slow — but bounds a wedged cycle
  // so it can't starve the scheduler. 2 minutes.
  MONITOR_CYCLE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // Opt-in headless-browser fallback for `fetch_strategy: browser` manifests.
  // Requires the optional Playwright deps; off by default so the base install
  // (e.g. Raspberry Pi) never needs Chromium.
  ENABLE_BROWSER_FALLBACK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Consecutive blocked/failed cycles before a vendor is circuit-broken (polling
  // paused until manual re-enable). Deliberately higher than
  // FAILURE_ALERT_THRESHOLD: telling the user a watch is failing is cheap and
  // early; giving up on polling a vendor entirely is a stronger, later decision.
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(10),
  // Cooldown before an open vendor breaker auto-probes (half-open). Default 30 min.
  CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30 * 60_000),
  // Auto-backup cadence (ms). Default weekly. The backup is uploaded to admins.
  BACKUP_INTERVAL_MS: z.coerce.number().int().positive().default(7 * 24 * 60 * 60_000),
  // Optional directory to also drop each backup snapshot into (besides Telegram).
  BACKUP_LOCAL_DIR: z.string().optional(),
  // Scheduler ticks between periodic DB maintenance (wal_checkpoint). Default
  // 360 ≈ 6h at the typical ~1-min tick cadence.
  DB_MAINTENANCE_INTERVAL_TICKS: z.coerce
    .number()
    .int()
    .positive()
    .default(360),
  // Days of access-decision audit history to retain; older rows are pruned
  // during DB maintenance so the audit_log stays bounded on a long-running Pi.
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  // Max monitors a single (non-admin) chat may register. A backstop against
  // accidental or abusive floods that would swamp the scheduler. 0 = unlimited.
  MAX_MONITORS_PER_CHAT: z.coerce.number().int().min(0).default(50),
  // Per-chat cooldown (ms) on /check — it forces a synchronous scrape, so spam
  // is expensive. Default 10s.
  CHECK_COOLDOWN_MS: z.coerce.number().int().min(0).default(10_000),
  // Per-chat cooldown (ms) on registering a watch from a pasted URL. Default 5s.
  URL_REGISTER_COOLDOWN_MS: z.coerce.number().int().min(0).default(5_000),
  // Port for a GET /health endpoint (0 = disabled). In webhook mode the health
  // route is served on WEBHOOK_PORT automatically; this only spins up a separate
  // listener for long-polling deployments that want a probe.
  HEALTH_CHECK_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
  // Grafana Cloud Loki log shipping (all three required to ship; else stdout-only).
  LOKI_URL: z.string().optional(),
  LOKI_USER: z.string().optional(),
  LOKI_TOKEN: z.string().optional(),
  LOG_SERVICE: z.string().default("agor"),
  LOG_ENV: z.string().default("prod"),
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
  /** Bootstrap admin chat ids; empty ⇒ access control is fail-open. */
  adminChatIds: number[];
  defaultCheckIntervalMs: number;
  oosFastIntervalMs: number;
  dedupWindowMs: number;
  benchmarkMinSample: number;
  proxyBenchCooldownMs: number;
  /** Hard ceiling (ms) on a single monitor's poll cycle. */
  monitorCycleTimeoutMs: number;
  /** Consecutive unhealthy cycles before the chat is told a watch is failing. */
  failureAlertThreshold: number;
  /** When true, attach the headless-browser fallback for opted-in manifests. */
  enableBrowserFallback: boolean;
  /** Consecutive blocked/failed cycles before a vendor is circuit-broken. */
  circuitBreakerThreshold: number;
  /** Cooldown (ms) before an open vendor breaker auto-probes (half-open). */
  circuitBreakerCooldownMs: number;
  /** Auto-backup cadence (ms); the snapshot is uploaded to admins. */
  backupIntervalMs: number;
  /** Optional directory to also write each backup snapshot to. */
  backupLocalDir?: string;
  /** Scheduler ticks between periodic DB maintenance (wal_checkpoint). */
  dbMaintenanceIntervalTicks: number;
  /** Days of audit-log history to retain (older rows pruned during maintenance). */
  auditRetentionDays: number;
  /** Max monitors a non-admin chat may register (0 = unlimited). */
  maxMonitorsPerChat: number;
  /** Per-chat cooldown (ms) on the /check on-demand poll. */
  checkCooldownMs: number;
  /** Per-chat cooldown (ms) on registering a watch from a pasted URL. */
  urlRegisterCooldownMs: number;
  /** Port for the GET /health endpoint (0 = disabled in long-poll mode). */
  healthCheckPort: number;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
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
    adminChatIds: numericCsv(parsed.ADMIN_CHAT_IDS),
    defaultCheckIntervalMs: parsed.DEFAULT_CHECK_INTERVAL_MS,
    oosFastIntervalMs: parsed.OOS_FAST_INTERVAL_MS,
    dedupWindowMs: parsed.DEDUP_WINDOW_MS,
    benchmarkMinSample: parsed.BENCHMARK_MIN_SAMPLE,
    proxyBenchCooldownMs: parsed.PROXY_BENCH_COOLDOWN_MS,
    monitorCycleTimeoutMs: parsed.MONITOR_CYCLE_TIMEOUT_MS,
    failureAlertThreshold: parsed.FAILURE_ALERT_THRESHOLD,
    enableBrowserFallback: parsed.ENABLE_BROWSER_FALLBACK,
    circuitBreakerThreshold: parsed.CIRCUIT_BREAKER_THRESHOLD,
    circuitBreakerCooldownMs: parsed.CIRCUIT_BREAKER_COOLDOWN_MS,
    backupIntervalMs: parsed.BACKUP_INTERVAL_MS,
    ...(parsed.BACKUP_LOCAL_DIR !== undefined ? { backupLocalDir: parsed.BACKUP_LOCAL_DIR } : {}),
    dbMaintenanceIntervalTicks: parsed.DB_MAINTENANCE_INTERVAL_TICKS,
    auditRetentionDays: parsed.AUDIT_RETENTION_DAYS,
    maxMonitorsPerChat: parsed.MAX_MONITORS_PER_CHAT,
    checkCooldownMs: parsed.CHECK_COOLDOWN_MS,
    urlRegisterCooldownMs: parsed.URL_REGISTER_COOLDOWN_MS,
    // In webhook mode the health route rides the existing webhook listener;
    // otherwise it only runs when an explicit HEALTH_CHECK_PORT is set.
    healthCheckPort: parsed.WEBHOOK_URL
      ? parsed.WEBHOOK_PORT
      : parsed.HEALTH_CHECK_PORT,
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
