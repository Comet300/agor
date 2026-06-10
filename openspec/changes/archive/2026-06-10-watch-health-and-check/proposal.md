## Why

When a watch breaks — OLX blocks it (`403`), a vendor changes its page shape (soft-fail extraction), or a manifest path drifts (scrape returns `ok` but **zero** items) — the bot goes **silent**. The cycle returns nothing and the user has no idea their watch stopped working. We now log this to Grafana, but the *user* still isn't told. Add **failure surfacing** (a chat notice when a watch is repeatedly failing, and a recovery notice when it works again) and a **`/check` command** to force a poll on demand (so you can confirm a watch without waiting for its interval).

## What Changes

- **Track consecutive failures** per monitor. A cycle is *unhealthy* when the scrape fails (`!ok`) — or, for a search that previously had listings, when it returns `ok` with **zero** items (a likely block/manifest break). Healthy cycles reset the counter.
- **Notify the chat once** when a watch reaches the failure threshold (default 3) — "this watch looks blocked / is finding nothing" — and **once on recovery** — "working again". No per-cycle spam.
- **`/check <id>`**: run a poll immediately for a monitor the chat owns and reply with the outcome (ok / items / new / failed); also add it to the command menu.
- The cycle now reports a structured **CycleResult** (`ok`, status, item counts) up to the orchestrator, which owns health tracking and dispatch.

## Capabilities

### New Capabilities

- `watch-health`: per-monitor consecutive-failure tracking; a one-shot "failing" notice at the threshold and a "recovered" notice on recovery; on-demand `/check`.

### Modified Capabilities

- `command-surface`: ADD the `/check <id>` command (and its command-menu entry).
- `persistence-layer`: ADD persistence of a monitor's consecutive-failure count.

## Impact

- **Config**: `FAILURE_ALERT_THRESHOLD` (default 3).
- **Contracts**: `Notification.item` becomes optional; add `watch_failing`/`watch_recovered` kinds + a `health` payload.
- **Code**: cycle returns `CycleResult`; orchestrator gains `runAndDispatch` + health tracking; `MonitorRepo` gains `consecutive_failures` (+ `setFailures`); gateway renders the health notices and handles `/check`; catalog strings (RO/EN).
- **Tests**: health threshold/recovery, empty-search detection, `/check` summary, and the updated `runMonitorOnce`/`cycle.run` return shape.
- **No scraping/pipeline change.** Operational: restart to apply.
