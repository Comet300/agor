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

/** Base pino options: level, the `service` base field, and secret redaction. */
export function buildLoggerOptions(config: AppConfig): LoggerOptions {
  return {
    level: config.logLevel,
    base: { service: config.logService },
    redact: {
      paths: ['token', 'password', 'authorization', 'botToken', 'lokiToken', 'secret'],
      censor: '[redacted]',
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
