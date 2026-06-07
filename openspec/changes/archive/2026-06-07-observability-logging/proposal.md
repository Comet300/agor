## Why

The bot runs 24/7 but emits **no operational logs** beyond a startup line: `LOG_LEVEL` is wired to nothing, and a poll leaves no trace. We literally could not answer "did the OLX watcher check alright every time?" — the database overwrites per-cycle state, and a transient `403` soft-fails silently. We need structured logging of **every poll** (and the surrounding lifecycle), shipped to **Grafana Cloud (Loki)** so behavior is queryable and failures are visible.

## What Changes

- Introduce a **structured logger** (pino) wired to `LOG_LEVEL`, replacing the bare `console.*` calls in operational paths.
- **Log every poll**: one structured event per monitor cycle — vendor, type, ok/fail, HTTP status, items seen, new items, notifications dispatched, duration — plus failures (soft-fail extraction, `429`/`403` proxy bench + retry) and each alert dispatched.
- **Ship to Grafana Cloud Loki** when configured: a `pino-loki` transport batches logs to `${LOKI_URL}/loki/api/v1/push` with Basic auth (`LOKI_USER` : `LOKI_TOKEN`) and service/env labels. Always also log JSON to **stdout** (captured by PM2). When Loki is unconfigured, stdout-only — nothing breaks.
- **Never log secrets** (bot token, proxy creds, Loki token are excluded).
- Add config + `.env.example` keys and a Grafana Cloud section to the deployment runbook.

## Capabilities

### New Capabilities

- `observability`: structured logging of every poll and key lifecycle/failure events, level-controlled by `LOG_LEVEL`, shipped to Grafana Cloud Loki when configured (stdout always), with secrets redacted.

### Modified Capabilities
None (logging is additive instrumentation; no behavior change to existing capabilities).

## Impact

- **Dependencies**: `pino`, `pino-loki`.
- **Config**: `LOKI_URL`, `LOKI_USER`, `LOKI_TOKEN`, `LOG_SERVICE`/`LOG_ENV` labels; `LOG_LEVEL` enum widened to pino levels (`trace…fatal`, `silent`).
- **Code**: new `src/logging/logger.ts`; instrumentation in the scheduler, orchestrator cycle, scraping engine, registration, gateway notifier, and `src/index.ts` (configure logging first; structured boot log).
- **Operational**: the operator supplies the three Loki values in `.env` (documented). Tests run `silent`. No change to scraping/pipeline/scheduler behavior.
