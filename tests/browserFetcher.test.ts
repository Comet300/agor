/**
 * Browser-fetcher resilience: launch-failure recovery, per-step deadlines, and
 * the body-size cap — all exercised through the injectable launcher seam so no
 * real Chromium is needed.
 */
import { describe, it, expect } from 'vitest';
import { createBrowserFetcher, isChallengePage, type BrowserLauncher } from '../src/scraping/browserFetcher';

/** A fake page whose content()/goto behaviour each test controls. */
function fakePage(opts: { content?: () => Promise<string>; gotoStatus?: number } = {}) {
  return {
    setExtraHTTPHeaders: async () => {},
    goto: async () => ({ status: () => opts.gotoStatus ?? 200, headers: () => ({}), url: () => 'https://x/final' }),
    content: opts.content ?? (async () => '<html>ok</html>'),
  };
}

/** A fake browser/context wrapping a page; records whether the context closed. */
function fakeBrowser(page: ReturnType<typeof fakePage>, closed: { context: boolean }) {
  return {
    newContext: async () => ({
      newPage: async () => page,
      close: async () => { closed.context = true; },
    }),
    close: async () => {},
  };
}

const headers = { 'User-Agent': 'UA' };

describe('createBrowserFetcher resilience', () => {
  it('retries the launcher after a transient launch failure (no permanent rejection)', async () => {
    let calls = 0;
    const closed = { context: false };
    const launcher: BrowserLauncher = async () => {
      calls++;
      if (calls === 1) throw new Error('transient import failure');
      return fakeBrowser(fakePage(), closed) as never;
    };
    const fetch = createBrowserFetcher({ launcher });

    await expect(fetch('https://x/1', { headers })).rejects.toThrow('transient import failure');
    // Second call must attempt the launch again, not return the cached rejection.
    const r = await fetch('https://x/2', { headers });
    expect(calls).toBe(2);
    expect(r.status).toBe(200);
    expect(r.body).toContain('ok');
  });

  it('enforces a deadline on a hung content() read and still closes the context', async () => {
    const closed = { context: false };
    const page = fakePage({ content: () => new Promise<string>(() => {}) }); // never resolves
    const launcher: BrowserLauncher = async () => fakeBrowser(page, closed) as never;
    const fetch = createBrowserFetcher({ launcher, timeoutMs: 30 });

    await expect(fetch('https://x', { headers })).rejects.toThrow(/deadline/i);
    expect(closed.context).toBe(true); // finally-block teardown ran
  });

  it('caps an oversized rendered body to maxBodyBytes', async () => {
    const closed = { context: false };
    const huge = 'x'.repeat(5000);
    const page = fakePage({ content: async () => huge });
    const launcher: BrowserLauncher = async () => fakeBrowser(page, closed) as never;
    const fetch = createBrowserFetcher({ launcher, maxBodyBytes: 1000 });

    const r = await fetch('https://x', { headers });
    expect(r.body.length).toBe(1000);
  });

  it('passes a normal body through unchanged when under the cap', async () => {
    const closed = { context: false };
    const launcher: BrowserLauncher = async () => fakeBrowser(fakePage(), closed) as never;
    const fetch = createBrowserFetcher({ launcher, maxBodyBytes: 1000 });
    const r = await fetch('https://x', { headers });
    expect(r.body).toBe('<html>ok</html>');
  });

  it('creates a hardened context (locale, timezone, viewport) and injects a fingerprint script', async () => {
    let ctxOpts: Record<string, unknown> | undefined;
    let initScript: string | undefined;
    const launcher: BrowserLauncher = async () =>
      ({
        newContext: async (opts: Record<string, unknown>) => {
          ctxOpts = opts;
          return {
            newPage: async () => fakePage(),
            addInitScript: async (s: string) => { initScript = s; },
            close: async () => {},
          };
        },
        close: async () => {},
      }) as never;

    const fetch = createBrowserFetcher({ launcher });
    await fetch('https://x', { headers });

    expect(ctxOpts).toMatchObject({
      userAgent: 'UA',
      locale: 'ro-RO',
      timezoneId: 'Europe/Bucharest',
      viewport: { width: 1920, height: 1080 },
    });
    expect(initScript).toContain('navigator');
    expect(initScript).toContain('WebGLRenderingContext'); // WebGL vendor spoof present
  });

  it('isChallengePage detects interstitials but not a normal page', () => {
    expect(isChallengePage('<title>Just a moment...</title>')).toBe(true);
    expect(isChallengePage('<div class="cf-chl-widget"></div>')).toBe(true);
    expect(isChallengePage('<html><body>VW Golf, 4300 lei</body></html>')).toBe(false);
  });

  it('waits through a non-interactive interstitial and returns the resolved page', async () => {
    const closed = { context: false };
    let call = 0;
    // First two content reads are the challenge; then it auto-resolves.
    const page = fakePage({
      content: async () => (++call <= 2 ? '<title>Just a moment...</title>' : '<html>real page</html>'),
    });
    const launcher: BrowserLauncher = async () => fakeBrowser(page, closed) as never;
    const fetch = createBrowserFetcher({ launcher, challengePollMs: 5, sleep: async () => {} });

    const r = await fetch('https://x', { headers });
    expect(r.body).toBe('<html>real page</html>');
    expect(call).toBeGreaterThanOrEqual(3);
  });

  it('gives up after the budget and returns the challenge body (no throw)', async () => {
    const closed = { context: false };
    const page = fakePage({ content: async () => '<title>Just a moment...</title>' }); // never clears
    const launcher: BrowserLauncher = async () => fakeBrowser(page, closed) as never;
    const fetch = createBrowserFetcher({ launcher, challengeWaitMs: 20, challengePollMs: 5, sleep: async () => {} });

    const r = await fetch('https://x', { headers });
    expect(isChallengePage(r.body)).toBe(true); // surfaced for block detection
    expect(closed.context).toBe(true);
  });
});
