import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { healthSnapshot, healthHandler, type HealthDeps } from '../src/gateway/health';

function deps(over: Partial<HealthDeps> = {}): HealthDeps {
  return {
    getLastTickAt: () => 1_000,
    getLastDueCount: () => 3,
    now: () => 2_000,
    staleAfterMs: 60_000,
    ...over,
  };
}

/** A minimal fake (req,res) capturing the response. */
function fakeReqRes(method: string, url: string) {
  const out = { status: 0, body: '', headers: {} as Record<string, string>, ended: false };
  const req = { method, url } as IncomingMessage;
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => { out.status = s; if (h) out.headers = h; return res; },
    end: (b?: string) => { if (b) out.body = b; out.ended = true; },
  } as unknown as ServerResponse;
  return { req, res, out };
}

describe('healthSnapshot', () => {
  it('ok when the last tick is recent', () => {
    const s = healthSnapshot(deps({ getLastTickAt: () => 1_999 }));
    expect(s.ok).toBe(true);
    expect(s.lastTickAt).toBe(1_999);
    expect(s.lastDueCount).toBe(3);
  });
  it('NOT ok when the last tick is stale (scheduler stalled)', () => {
    const s = healthSnapshot(deps({ getLastTickAt: () => 1_000, now: () => 1_000_000 }));
    expect(s.ok).toBe(false);
  });
  it('ok before the first tick (just booted, do not flap)', () => {
    const s = healthSnapshot(deps({ getLastTickAt: () => null }));
    expect(s.ok).toBe(true);
    expect(s.lastTickAt).toBeNull();
  });
});

describe('healthHandler', () => {
  it('answers GET /health with 200 + JSON and reports handled', () => {
    const { req, res, out } = fakeReqRes('GET', '/health');
    const handled = healthHandler(deps())(req, res);
    expect(handled).toBe(true);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toMatchObject({ ok: true, lastDueCount: 3 });
  });

  it('returns 503 on /health when unhealthy', () => {
    const { req, res, out } = fakeReqRes('GET', '/health');
    healthHandler(deps({ getLastTickAt: () => 1, now: () => 9_999_999 }))(req, res);
    expect(out.status).toBe(503);
  });

  it('delegates a non-/health request to next (and reports NOT handled)', () => {
    const { req, res } = fakeReqRes('POST', '/webhook');
    let nexted = false;
    const handled = healthHandler(deps())(req, res, () => { nexted = true; });
    expect(handled).toBe(false);
    expect(nexted).toBe(true);
  });

  it('404s a non-/health request when no next handler is given', () => {
    const { req, res, out } = fakeReqRes('GET', '/other');
    healthHandler(deps())(req, res);
    expect(out.status).toBe(404);
  });
});
