/**
 * Health / readiness endpoint.
 *
 * Exposes `GET /health` → 200 + JSON so an external probe (PM2, a tunnel
 * healthcheck, uptime monitor) can confirm the bot is alive AND actually
 * polling. In webhook mode the handler is layered ahead of the grammY callback
 * on the existing listener; in long-poll mode a tiny dedicated listener is
 * started when a port is configured.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { log } from '../logging/logger';

/** The data the health endpoint reports; read live from the scheduler. */
export interface HealthDeps {
  /** Epoch ms of the last completed scheduler tick (null if it never fired). */
  getLastTickAt: () => number | null;
  /** Monitors processed in the last tick (diagnostic). */
  getLastDueCount: () => number;
  /** Clock seam; defaults to the wall clock. */
  now?: () => number;
  /**
   * A tick older than this (ms) marks the bot unhealthy (the scheduler has
   * stalled). Generous default so a slow/idle cadence isn't flagged.
   */
  staleAfterMs?: number;
}

export interface HealthResponse {
  ok: boolean;
  /** Epoch ms of the last scheduler tick, or null before the first tick. */
  lastTickAt: number | null;
  /** Monitors processed in the last tick. */
  lastDueCount: number;
  /** Process uptime in seconds. */
  uptimeSec: number;
}

/** 30 minutes: well above any normal tick cadence, so only a real stall trips it. */
const DEFAULT_STALE_AFTER_MS = 30 * 60_000;

/** Compute the current health snapshot from the deps. */
export function healthSnapshot(deps: HealthDeps): HealthResponse {
  const now = (deps.now ?? (() => Date.now()))();
  const lastTickAt = deps.getLastTickAt();
  const staleAfter = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  // Healthy once the scheduler has ticked and the last tick isn't stale. Before
  // the first tick we report ok:true (just-booted) so a probe doesn't flap on start.
  const ok = lastTickAt === null ? true : now - lastTickAt < staleAfter;
  return { ok, lastTickAt, lastDueCount: deps.getLastDueCount(), uptimeSec: Math.round(process.uptime()) };
}

/**
 * An HTTP handler that answers `GET /health` and otherwise delegates to `next`
 * (when given) or 404s. Returns true when it handled the request, so a caller
 * layering it ahead of another handler knows whether to stop.
 */
export function healthHandler(deps: HealthDeps) {
  return (req: IncomingMessage, res: ServerResponse, next?: (req: IncomingMessage, res: ServerResponse) => void): boolean => {
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      const body = JSON.stringify(healthSnapshot(deps));
      res.writeHead(healthSnapshot(deps).ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(body);
      return true;
    }
    if (next) {
      next(req, res);
      return false;
    }
    res.writeHead(404);
    res.end();
    return false;
  };
}

/**
 * Start a dedicated health listener (long-poll mode). No-op returning undefined
 * when `port` is 0/disabled. The returned {@link Server} is closed on shutdown.
 */
export function startHealthServer(port: number, deps: HealthDeps): Server | undefined {
  if (!port) return undefined;
  const handle = healthHandler(deps);
  const server = createServer((req, res) => handle(req, res));
  server.listen(port, () => log('health').info({ port }, 'health endpoint listening'));
  return server;
}
