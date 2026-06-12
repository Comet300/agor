/**
 * Structured logging (pino), configured once at startup.
 *
 * Always writes JSON to stdout (captured by PM2). When a full Loki config is
 * present (`lokiUrl` + `lokiUser` + `lokiToken`) it ALSO ships batched logs to
 * Grafana Cloud Loki. Components log via `log(component)` (a child logger), so a
 * module-level root reconfigured by {@link configureLogging} is reflected.
 */
import pino, { type Logger, type LoggerOptions, type TransportTargetOptions } from 'pino';
import type { AppConfig } from '../config';

/** Root logger; replaced by {@link configureLogging}. Default honors LOG_LEVEL env. */
let root: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/** True when all three Loki settings are present (so shipping is enabled). */
export function hasLoki(config: AppConfig): boolean {
  return Boolean(config.lokiUrl && config.lokiUser && config.lokiToken);
}

/** Object keys that must never be logged in clear, at any nesting depth. */
const REDACT_KEYS = [
  'token',
  'password',
  'authorization',
  'botToken',
  'lokiToken',
  'lokiUser',
  'secret',
  'webhookSecret',
  'secretToken',
  'secret_token',
];

/**
 * Pino `redact.paths` covering each secret key both at the top level and one
 * level deep under any property (`*.key`), since secrets are usually nested in a
 * logged object (e.g. `{ err: { config: { token } } }`).
 */
function redactPaths(): string[] {
  const paths: string[] = [];
  for (const k of REDACT_KEYS) {
    paths.push(k, `*.${k}`);
  }
  return paths;
}

/**
 * Collect the concrete secret VALUES from config so they can be scrubbed even
 * when they appear inline in free text (an error message, a URL). Short/empty
 * values are skipped to avoid over-redacting common substrings.
 */
export function secretValues(config: AppConfig): string[] {
  const candidates = [
    config.botToken,
    config.lokiToken,
    config.lokiUser,
    config.webhookSecret,
    config.webhookUrl,
    ...config.proxyUrls,
  ];
  return candidates.filter((v): v is string => typeof v === 'string' && v.length >= 6);
}

/** Replace every known secret value found inside `text` with `[redacted]`. */
export function scrubSecrets(text: string, secrets: string[]): string {
  if (!text) return text;
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join('[redacted]');
  }
  return out;
}

/** Base pino options: level, the `service` base field, and secret redaction. */
export function buildLoggerOptions(config: AppConfig): LoggerOptions {
  const secrets = secretValues(config);
  return {
    level: config.logLevel,
    base: { service: config.logService },
    redact: { paths: redactPaths(), censor: '[redacted]' },
    // Scrub secret values that leak into an Error's message/stack (key-based
    // redaction can't catch a token embedded in free text).
    serializers: {
      err: (err: unknown) => {
        const s = pino.stdSerializers.err(err as Error) as Record<string, unknown>;
        if (typeof s.message === 'string') s.message = scrubSecrets(s.message, secrets);
        if (typeof s.stack === 'string') s.stack = scrubSecrets(s.stack, secrets);
        return s;
      },
    },
  };
}

/** Transport targets: stdout always; Loki when fully configured. */
export function buildTargets(config: AppConfig): TransportTargetOptions[] {
  const targets: TransportTargetOptions[] = [
    { target: 'pino/file', level: config.logLevel, options: { destination: 1 } },
  ];
  if (hasLoki(config)) {
    targets.push({
      target: 'pino-loki',
      level: config.logLevel,
      options: {
        host: config.lokiUrl,
        basicAuth: { username: config.lokiUser, password: config.lokiToken },
        labels: { service: config.logService, env: config.logEnv },
        batching: true,
        interval: 5,
      },
    });
  }
  return targets;
}

/** Build the root logger from config (multi-target transport). */
export function configureLogging(config: AppConfig): void {
  // `silent` ⇒ no transport worker at all.
  if (config.logLevel === 'silent') {
    root = pino({ level: 'silent' });
    return;
  }
  root = pino(buildLoggerOptions(config), pino.transport({ targets: buildTargets(config) }));
}

/** A child logger tagged with `component`. Reads the current configured root. */
export function log(component: string): Logger {
  return root.child({ component });
}
