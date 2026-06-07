## Context

The app logs only at boot (`console.info`). `LOG_LEVEL` exists in config but nothing reads it. Runs on a Raspberry Pi under PM2 (PM2 captures stdout to files). The operator wants every poll logged and everything shipped to Grafana Cloud. Grafana Cloud's logs product is Loki; its push API is `POST ${LOKI_URL}/loki/api/v1/push` with HTTP Basic auth (username = numeric instance id, password = an Access-Policy token scoped `logs:write`).

## Goals / Non-Goals

**Goals:** one structured log per poll (queryable: vendor, ok, status, items, new, duration); failures (soft-fail, proxy bench) visible; ship to Loki when configured; stdout always (PM2); `LOG_LEVEL`-controlled; no secrets in logs; nothing breaks without Loki creds.

**Non-Goals:** Prometheus metrics (a natural follow-up; this change is logs). No log of message *contents* of user chats. No agent install (app pushes directly).

## Decisions

### pino, configured once at boot
`pino` for structured JSON. A small `src/logging/logger.ts` exposes `configureLogging(config)` (called first thing in `main()`), and `log(component)` returning a child logger (`{ service, component }`). A module-level root is reconfigured by `configureLogging`; components call `log(...)` at log-time so they see the configured root. *Why pino:* fast, structured, first-class transports, ubiquitous. *Why singleton over dependency-injection:* avoids threading a logger through every constructor (and their tests) — the instrumentation is additive `log('x').info(...)` calls, not signature changes.

### Multi-target transport: stdout + Loki
`pino.transport({ targets: [...] })` with a `pino/file → fd 1` target (always) and a `pino-loki` target **only when** `LOKI_URL`/`LOKI_USER`/`LOKI_TOKEN` are all set:
```
{ target: 'pino-loki', options: { host: LOKI_URL, basicAuth: { username: LOKI_USER, password: LOKI_TOKEN },
  labels: { service: LOG_SERVICE, env: LOG_ENV }, batching: true, interval: 5 } }
```
pino-loki appends `/loki/api/v1/push` and batches (default 5s / 10k buffer, dropping oldest if Loki is unreachable — bounded memory). *Why app-direct push over a Grafana Alloy agent:* lowest operator friction (three env vars, no agent install); stdout+PM2 remains the durable local copy. The runbook notes Alloy as a more-robust alternative.

### The per-poll event is the headline
The orchestrator cycle emits exactly one event per monitor poll at `info`: `{ monitorId, vendor, type, ok, status, itemsActive, newItems, notifications, durationMs }` (msg `"poll"`), or `warn` with `{ …, reason }` on failure. This single line answers "did it check alright every time?". The engine adds `debug` fetch events and `warn` on `429/403` bench + soft-fail extraction; registration and notifier add their own events. Errors everywhere log with the error.

### Secrets are never logged
Config is never logged whole. The boot log includes only non-secret summary (mode, db path, vendor count, whether a proxy/loki is configured — booleans, not values). pino `redact` guards stray `token`/`password`/`authorization` keys as defence-in-depth.

### LOG_LEVEL widened to pino levels; tests silent
`LOG_LEVEL` enum becomes `trace|debug|info|warn|error|fatal|silent`, mapping straight to pino. Vitest sets `LOG_LEVEL=silent` so the suite stays quiet and no transport worker spins up in tests.

## Risks / Trade-offs

- **Loki unreachable** → pino-loki batches in memory and drops oldest past the buffer cap; stdout/PM2 still has everything. No crash, bounded memory.
- **Worker-thread transport under tsx** → validated: pino's worker transport loads and flushes under tsx/ESM (pure-JS transport targets).
- **Log volume / cost** → one `info` line per poll (~1/30 min/monitor) is tiny; `debug` fetch lines are gated by `LOG_LEVEL`. Free-tier Loki is ample.
- **PII** → only listing metadata and ids are logged, never user message text or seller phone.

## Migration Plan

Additive. Without `LOKI_*` set, behavior is stdout-only structured logs (an improvement over today). Deploy: add the three Loki env vars, restart; logs appear in Grafana within seconds. Rollback: unset `LOKI_*` (stdout-only) or revert the change.

## Open Questions

- Ship metrics (Prometheus remote_write) too? Deferred — logs satisfy "log all polls"; metrics is a clean follow-up using the same Grafana Cloud account.
