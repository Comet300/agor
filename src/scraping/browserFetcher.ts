/**
 * Headless-browser transport for `fetch_strategy: browser` manifests.
 *
 * This is the escalation path the engine takes only when an HTTP fetch hits a
 * recognised anti-bot hard block (Akamai/DataDome/…). It drives a real Chromium
 * via Playwright with the stealth plugin so the TLS/JA3 fingerprint, navigator
 * surface, and cookies look like a genuine browser — the things a raw undici GET
 * cannot mimic.
 *
 * Playwright and its stealth plugin are OPTIONAL dependencies, imported lazily
 * the first time a browser fetch is actually needed. A deployment that never
 * opts a manifest into `browser` (e.g. the Raspberry Pi default) never installs
 * or loads Chromium. When the dependency is missing, a clear, actionable error
 * is thrown rather than a cryptic module-not-found.
 */
import type { Fetcher } from './engine';
import { log } from '../logging/logger';

/** The minimal slice of the Playwright API this module uses. */
interface ContextOptions {
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  viewport?: { width: number; height: number };
}
interface BrowserHandle {
  newContext(opts: ContextOptions): Promise<ContextHandle>;
  close(): Promise<void>;
}
interface ContextHandle {
  newPage(): Promise<PageHandle>;
  /** Run a script in every page before its own scripts (fingerprint hardening). */
  addInitScript?(script: string): Promise<void>;
  /** Seed the context with persisted session cookies before navigating. */
  addCookies?(cookies: { name: string; value: string; url: string }[]): Promise<void>;
  /** Read the context's cookies after navigation (to persist into the jar). */
  cookies?(): Promise<{ name: string; value: string; expires?: number }[]>;
  close(): Promise<void>;
}
interface PageHandle {
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  goto(
    url: string,
    opts: { waitUntil: 'domcontentloaded' | 'networkidle'; timeout: number },
  ): Promise<ResponseHandle | null>;
  content(): Promise<string>;
}
interface ResponseHandle {
  status(): number;
  headers(): Record<string, string>;
  url(): string;
}

/** Launches a headless browser; injectable so tests need no real Chromium. */
export type BrowserLauncher = () => Promise<BrowserHandle>;

/** Options controlling the headless browser transport. */
export interface BrowserFetcherOptions {
  /**
   * Per-navigation timeout in ms (default 45s — generous, networks can be slow).
   * Also the per-step deadline applied to content read and context teardown so a
   * single hung operation cannot block a polling cycle indefinitely.
   */
  timeoutMs?: number;
  /** Wait condition before reading content (default `domcontentloaded`). */
  waitUntil?: 'domcontentloaded' | 'networkidle';
  /** Hard cap on the rendered body kept (bytes); default {@link MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
  /** Browser launcher seam; defaults to the lazy Playwright import. */
  launcher?: BrowserLauncher;
  /** IANA timezone for the browser context (default Europe/Bucharest). */
  timezoneId?: string;
  /** Context locale (default ro-RO). */
  locale?: string;
  /**
   * Max time (ms) to wait for a JS interstitial (Cloudflare "Just a moment",
   * managed challenge) to auto-resolve before giving up. Default 12s; 0 disables.
   */
  challengeWaitMs?: number;
  /** Poll interval (ms) while waiting for an interstitial to clear (default 1.5s). */
  challengePollMs?: number;
  /** Sleep seam for the interstitial wait loop; injected in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Substrings that mark a JS interstitial / anti-bot challenge holding page. */
const CHALLENGE_SIGNATURES = [
  'just a moment',
  'checking your browser before accessing',
  'cf-chl', // Cloudflare challenge token markup
  'challenge-platform',
  'challenge-running',
  'cf_chl_opt',
  'turnstile',
];

/**
 * Heuristic: does this HTML look like an interstitial rather than the real page?
 * Signature substrings are matched case-insensitively. Exported for tests.
 */
export function isChallengePage(html: string): boolean {
  const h = html.toLowerCase();
  return CHALLENGE_SIGNATURES.some((sig) => h.includes(sig));
}

/**
 * Fingerprint-hardening script injected into every page before its own scripts
 * run. The stealth plugin covers `navigator.webdriver` and the headless-Chrome
 * tells; this reinforces a consistent, plausible identity (languages, core/RAM
 * counts, WebGL vendor) so an anti-bot script that probes those surfaces sees a
 * coherent desktop browser rather than a default headless profile. Best-effort:
 * each patch is isolated so a locked-down property cannot abort the rest.
 */
const HARDENING_SCRIPT = `
(() => {
  const def = (obj, prop, get) => { try { Object.defineProperty(obj, prop, { get }); } catch (e) {} };
  def(navigator, 'languages', () => ['ro-RO', 'ro', 'en-US', 'en']);
  def(navigator, 'hardwareConcurrency', () => 8);
  def(navigator, 'deviceMemory', () => 8);
  try {
    const gp = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';          // UNMASKED_VENDOR_WEBGL
      if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      return gp.call(this, p);
    };
  } catch (e) {}
})();
`;

/** Generous body cap — far above any real listing page (~30 MB). */
const MAX_BODY_BYTES = 30 * 1024 * 1024;

/** Cached browser launch promise so repeated fetches reuse one Chromium. */
let browserPromise: Promise<BrowserHandle> | undefined;

/** Reject a promise if it does not settle within `ms` (a hung step guard). */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`browser ${what} exceeded ${ms}ms deadline`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Lazily import Playwright (+ stealth) and launch a shared headless Chromium.
 * Throws an actionable error when the optional dependency is not installed.
 *
 * On ANY failure the cached promise is cleared so the next call retries — a
 * transient launch/import error must not permanently disable the browser path.
 */
async function launchBrowser(): Promise<BrowserHandle> {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    let chromium: { launch(opts: { headless: boolean; args: string[] }): Promise<BrowserHandle> };
    try {
      // Lazy, optional: only loaded when a manifest opts into the browser path.
      // The specifiers are held in variables so the typechecker does not try to
      // resolve the optional packages' types at build time.
      const playwrightExtra = 'playwright-extra';
      const stealthPlugin = 'puppeteer-extra-plugin-stealth';
      const extra = (await import(playwrightExtra)) as unknown as {
        chromium: typeof chromium & { use(plugin: unknown): void };
      };
      try {
        const stealth = (await import(stealthPlugin)) as unknown as {
          default: () => unknown;
        };
        extra.chromium.use(stealth.default());
      } catch {
        log('browser').warn({}, 'stealth plugin unavailable — continuing without it');
      }
      chromium = extra.chromium;
    } catch (err) {
      throw new Error(
        'fetch_strategy "browser" requires the optional dependencies ' +
          '`playwright-extra`, `playwright`, and `puppeteer-extra-plugin-stealth`. ' +
          'Install them (and `npx playwright install chromium`) to enable the browser ' +
          `fallback, or set the manifest back to fetch_strategy: http. Cause: ${(err as Error).message}`,
      );
    }
    return chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage', // avoid /dev/shm exhaustion on small hosts (Pi)
        '--lang=ro-RO',
      ],
    });
  })().catch((err) => {
    // Clear the cache so a transient failure does not permanently reject every
    // future call; the next fetch will attempt the launch again.
    browserPromise = undefined;
    throw err;
  });
  return browserPromise;
}

/**
 * Build a {@link Fetcher} that renders pages in a real headless browser. The
 * returned fetcher matches the HTTP fetcher's contract (status + body + headers
 * + finalUrl) so the engine treats both transports identically.
 */
export function createBrowserFetcher(options: BrowserFetcherOptions = {}): Fetcher {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const waitUntil = options.waitUntil ?? 'domcontentloaded';
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const launcher = options.launcher ?? launchBrowser;
  const timezoneId = options.timezoneId ?? 'Europe/Bucharest';
  const locale = options.locale ?? 'ro-RO';
  const challengeWaitMs = options.challengeWaitMs ?? 12_000;
  const challengePollMs = options.challengePollMs ?? 1_500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async (url, { headers, cookie }) => {
    const browser = await launcher();
    // A coherent desktop identity: UA + locale + timezone + a real viewport so a
    // fingerprint probe sees a consistent profile, not a default headless one.
    const context = await browser.newContext({
      userAgent: headers['User-Agent'],
      locale,
      timezoneId,
      viewport: { width: 1920, height: 1080 },
    });
    try {
      // Reinforce the JS fingerprint before any page script runs (best-effort).
      await context.addInitScript?.(HARDENING_SCRIPT);
      // Seed persisted session cookies so the browser arrives as a returning visitor.
      if (cookie && context.addCookies) {
        const seeded = cookie
          .split('; ')
          .map((p) => { const i = p.indexOf('='); return i > 0 ? { name: p.slice(0, i), value: p.slice(i + 1), url } : undefined; })
          .filter((c): c is { name: string; value: string; url: string } => c !== undefined);
        if (seeded.length) await context.addCookies(seeded).catch(() => undefined);
      }
      const page = await context.newPage();
      // Carry the same accept/client-hint headers the HTTP path sends.
      await page.setExtraHTTPHeaders(headers);
      const response = await page.goto(url, { waitUntil, timeout: timeoutMs });
      // Bound the content read too: page.goto's timeout does not cover it, and a
      // wedged renderer could otherwise hang the whole polling cycle.
      let raw = await withDeadline(page.content(), timeoutMs, 'content read');

      // Interstitial wait-through: a NON-interactive JS challenge (Cloudflare
      // "Just a moment", managed challenge) clears itself in a few seconds and
      // navigates to the real page. Keep the page alive and re-read content until
      // the challenge markup disappears or the budget runs out. An INTERACTIVE
      // Turnstile checkbox cannot be solved here — that needs a captcha-solving
      // service; we surface the challenge body and let block detection handle it.
      if (challengeWaitMs > 0 && isChallengePage(raw)) {
        log('browser').info({ url, event: 'INTERSTITIAL-WAIT' }, 'interstitial detected — waiting for auto-resolution');
        let waited = 0;
        while (isChallengePage(raw) && waited < challengeWaitMs) {
          await sleep(challengePollMs);
          waited += challengePollMs;
          raw = await withDeadline(page.content(), timeoutMs, 'content read');
        }
        if (isChallengePage(raw)) {
          log('browser').warn(
            { url, waited, event: 'INTERSTITIAL-UNCLEARED' },
            'interstitial did not clear (interactive Turnstile needs a captcha-solving service)',
          );
        } else {
          log('browser').info({ url, waited, event: 'INTERSTITIAL-CLEARED' }, 'interstitial auto-resolved');
        }
      }

      const body = raw.length > maxBodyBytes ? raw.slice(0, maxBodyBytes) : raw;
      // Persist whatever cookies the browser ended up with (esp. a freshly minted
      // cf_clearance) as Set-Cookie lines, so the cheap HTTP transport can reuse
      // them on subsequent polls.
      let setCookie: string[] | undefined;
      if (context.cookies) {
        try {
          const jarCookies = await context.cookies();
          setCookie = jarCookies.map((c) =>
            c.expires !== undefined && c.expires > 0
              ? `${c.name}=${c.value}; Expires=${new Date(c.expires * 1000).toUTCString()}`
              : `${c.name}=${c.value}`,
          );
        } catch { /* cookie read is best-effort */ }
      }
      return {
        status: response?.status() ?? 0,
        body,
        headers: response?.headers() ?? {},
        finalUrl: response?.url() ?? url,
        ...(setCookie && setCookie.length ? { setCookie } : {}),
      };
    } finally {
      // Teardown is also deadline-bounded so a stuck close cannot wedge the cycle.
      await withDeadline(context.close(), timeoutMs, 'context close').catch((err) => {
        log('browser').warn({ err: (err as Error).message }, 'context close failed');
      });
    }
  };
}

/** Close the shared browser (call on shutdown). Safe when never launched. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } finally {
    browserPromise = undefined;
  }
}
