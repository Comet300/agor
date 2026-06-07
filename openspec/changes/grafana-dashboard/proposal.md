## Why

The bot now ships structured logs to Grafana Cloud Loki, but there is no curated way to *view* them — an operator would have to hand-write LogQL in Explore. Ship a ready-to-import **Grafana dashboard** purpose-built for agor's log schema, so poll health, failures, durations, detections, and a live stream are one import away.

## What Changes

- Add `grafana/agor-logs.json` — an importable Grafana dashboard (Loki datasource) with panels over the `{service="agor"}` log stream: polls (total / failed), alerts sent, proxy benches, poll-outcome rate, poll duration p50/p95, new-listings detected, recent failures (logs), and a live poll stream — with a `vendor` template variable.
- Document import in `DEPLOYMENT.md` (Dashboards → Import → upload the JSON → pick the Loki datasource).

## Capabilities

### Modified Capabilities

- `observability`: ADD a provided, importable Grafana dashboard for the poll/log stream.

## Impact

- **New file**: `grafana/agor-logs.json` (static dashboard model; no code).
- **Docs**: a short "Dashboard" subsection in `DEPLOYMENT.md`.
- **No code/test/behavior change.** Requires the operator to have set the `logs:write` token so logs reach Loki.
