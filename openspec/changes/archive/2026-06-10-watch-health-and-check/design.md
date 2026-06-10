## Context

The scheduler calls `orchestrator.runMonitor(monitor)` → `cycle.run` → returns `Notification[]`; the orchestrator dispatches them. The cycle already computes ok/status/itemsActive/newItems (it logs them as the per-poll event) but discards them. There is no notion of a "failing" watch. Blocks/manifest-drift surface two ways: a soft-fail (`ok:false`) or — when a `json_path` stops matching — `ok:true` with an empty items array.

## Goals / Non-Goals

**Goals:** detect a failing watch and tell the chat once (and once on recovery); never spam; a `/check <id>` to poll on demand with an outcome reply; keep it localized (RO/EN).

**Non-Goals:** auto-repair/manifest fallback; per-cycle failure alerts; treating a *product* filtered-out-by-the-user (intentional, `ok:true` 0 items) as a failure; treating a genuinely empty brand-new search (no prior baseline) as a failure.

## Decisions

### Cycle reports a structured result
`cycle.run` returns `CycleResult { notifications, ok, status, itemsActive, newItems }` (the values it already logs). *Why:* the orchestrator needs ok/itemsActive to judge health, and `/check` needs them to reply. The orchestrator's `runMonitorOnce` returns the same result for `/check`; tests read `.notifications`.

### Health lives in the orchestrator, not the cycle
A shared `runAndDispatch(monitor)` runs the cycle, dispatches notifications (recording new-listing message refs as today), then evaluates health and persists the counter. *Why:* the cycle stays a pure poll-and-report unit; the orchestrator already owns dispatch and the store, and "unhealthy for search" needs `knownIds` (the store).

### Unhealthy rule (low false-alarm)
`unhealthy = !ok || (type === 'search' && ok && itemsActive === 0 && knownIds(monitor).size > 0)`.
- `!ok` covers `403`/`429`/soft-fail extraction (challenge pages parse-fail → `ok:false`).
- The search-empty arm catches manifest drift (a stale `json_path` yields `ok:true` with `[]`) **only** when the watch previously had listings, so a legitimately empty new search never alarms.
- Products: `!ok` only (a user filtering the single item out is `ok:true`/0 and must not alarm).

### One notice per episode
Increment on unhealthy; when the count *reaches* the threshold exactly, emit `watch_failing` once. On the next healthy cycle, if the count was ≥ threshold, emit `watch_recovered`, then reset to 0. So a long outage yields exactly one "failing" and later one "recovered" — no spam. Persisted via `MonitorRepo.setFailures` so it survives restarts.

### Notifications gain item-less kinds
`Notification.item` becomes optional; add `watch_failing`/`watch_recovered` with a `health` payload `{ monitorId, vendor, url, consecutiveFailures }`. `RenderedMessage.keyboard` becomes optional (health notices have no buttons). Listing kinds always carry `item` (rendered with a non-null assertion); the notifier guards `n.item?.id` in logs and only records a message ref for `new_listing` with an item.

### `/check` reuses the real cycle
`/check <id>` (chat-owned only) calls `orchestrator.runMonitorOnce(id)` (which runs `runAndDispatch`, so any alerts/health notices fire as in a real poll) and replies with a localized summary from the `CycleResult`. Added to `setMyCommands`.

## Risks / Trade-offs

- **A genuinely empty popular search** that *had* results but now legitimately has none (all sold) → one false "failing" notice, self-corrects with a "recovered" when listings return. Acceptable and rare; the threshold (3 consecutive) reduces it.
- **Optional `item`** could mask a missing item on a listing kind → mitigated by constructing those notifications only with an item and asserting at render.

## Migration Plan

Additive: new `consecutive_failures` column (idempotent migration, defaults 0). No behavior change to scraping/pipeline. Deploy: restart. Rollback: revert; the column is harmless if unused.

## Open Questions

- Re-remind after a long outage (e.g. a second notice after 24h still-failing)? Deferred — one notice keeps it calm; Grafana has the detail.
