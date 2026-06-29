/**
 * TLS/JA3-impersonating HTTP transport — a TypeScript translation of the
 * curl_cffi-style idea Scrapling's plain `Fetcher` uses.
 *
 * Our default transport is undici (`engine.defaultFetcher`). undici presents a
 * generic Node TLS ClientHello, so Cloudflare / DataDome / Akamai can flag the
 * JA3 fingerprint *before* reading a single header — and the only real-TLS path
 * we otherwise have is Playwright, which is heavy and gated to
 * `fetch_strategy: browser` manifests.
 *
 * `curl-impersonate` is a curl build that reproduces a real Chrome (or Firefox)
 * TLS handshake, HTTP/2 SETTINGS + frame ordering, and the exact default header
 * set + ORDER a browser sends — at the cost of a plain HTTP request. This module
 * shells that binary as a {@link Fetcher}, so every vendor (JSON- and
 * DOM-extractor alike) gets browser-grade fingerprinting on the page fetch that
 * precedes extraction, without launching a browser.
 *
 * The binary is an OPTIONAL, opt-in dependency (`ENABLE_TLS_IMPERSONATION` +
 * `CURL_IMPERSONATE_PATH`), mirroring the browser fallback: a base install never
 * needs it, and {@link composeFetcher} falls back to undici whenever the binary
 * is absent, errors, or times out.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fetcher, FetchResult } from './engine';
import { log } from '../logging/logger';

/** Generous body cap mirroring the undici transport (~30 MB). */
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Marker separating the response body from the `-w` metadata on stdout. */
const META = '\n__AGOR_CURL_META__';

/** Outcome of one curl invocation, before the fetcher parses it. */
export interface CurlRun {
  /** Process exit code (0 = success; curl error codes otherwise). */
  code: number;
  /** Raw stdout (body followed by the {@link META} metadata line). */
  stdout: Buffer;
  /** Contents of the `-D` header dump (one block per redirect hop). */
  headerText: string;
  /** Captured stderr (for diagnostics on a non-zero exit). */
  stderr: string;
}

/** Spawn seam: runs the binary with `args` and returns the captured streams. */
export type CurlRunner = (binary: string, args: string[], timeoutMs: number) => Promise<CurlRun>;

export interface ImpersonateOptions {
  /** Path/name of the curl-impersonate binary (e.g. `curl_chrome116`). */
  binary: string;
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Body cap in bytes (default {@link MAX_BODY_BYTES}). */
  maxBodyBytes?: number;
  /** Spawn seam; defaults to a real `child_process` runner. Injected in tests. */
  runner?: CurlRunner;
}

/** Default runner: spawn curl-impersonate, capture stdout + a header dump file. */
const defaultRunner: CurlRunner = async (binary, args, timeoutMs) => {
  const dir = await mkdtemp(join(tmpdir(), 'agor-curl-'));
  const headerPath = join(dir, 'h');
  const fullArgs = ['-D', headerPath, ...args];
  try {
    return await new Promise<CurlRun>((resolve, reject) => {
      const child = spawn(binary, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let outLen = 0;
      const err: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`curl-impersonate exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on('data', (c: Buffer) => {
        outLen += c.length;
        // Keep a little past the cap; the fetcher slices the body precisely.
        if (outLen <= MAX_BODY_BYTES + META.length + 256) out.push(c);
      });
      child.stderr.on('data', (c: Buffer) => err.push(c));
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', async (code) => {
        clearTimeout(timer);
        let headerText = '';
        try { headerText = await readFile(headerPath, 'utf8'); } catch { /* no dump */ }
        resolve({ code: code ?? 0, stdout: Buffer.concat(out), headerText, stderr: Buffer.concat(err).toString('utf8') });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** The final (post-redirect) header block of a `-D` dump. */
function finalHeaderBlock(headerText: string): string {
  const blocks = headerText.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  return blocks[blocks.length - 1] ?? '';
}

/** Parse the final header block of a `-D` dump into a lower-cased header map. */
function parseHeaders(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of finalHeaderBlock(headerText).split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue; // skip the "HTTP/2 200" status line and blanks
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

/** Collect every `Set-Cookie` line from the final header block (map loses dupes). */
function parseSetCookieLines(headerText: string): string[] {
  const lines: string[] = [];
  for (const line of finalHeaderBlock(headerText).split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    if (line.slice(0, idx).trim().toLowerCase() === 'set-cookie') lines.push(line.slice(idx + 1).trim());
  }
  return lines;
}

/**
 * Build a {@link Fetcher} backed by a curl-impersonate binary. The fetcher
 * forwards only `Accept-Language` from the caller's headers — the binary already
 * supplies a realistic Chrome User-Agent, client hints, and header ORDER, and
 * overriding those would defeat the impersonation. Throws on a missing binary or
 * a non-zero exit so {@link composeFetcher} can fall back to undici.
 */
export function createImpersonateFetcher(options: ImpersonateOptions): Fetcher {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const runner = options.runner ?? defaultRunner;

  return async (url, { headers, proxyUrl, cookie }): Promise<FetchResult> => {
    const args = [
      '-sS', // silent but surface errors on stderr
      '--compressed',
      '-L', // follow redirects (the binary keeps the impersonated profile per hop)
      '--max-redirs', String(MAX_REDIRECTS),
      '--max-time', String(Math.ceil(timeoutMs / 1000)),
    ];
    if (proxyUrl) args.push('-x', proxyUrl);
    // Carry the language preference only; the binary owns UA / client-hint order.
    const lang = headers['Accept-Language'] ?? headers['accept-language'];
    if (lang) args.push('-H', `Accept-Language: ${lang}`);
    // Replay persisted session cookies for this domain.
    if (cookie) args.push('-H', `Cookie: ${cookie}`);
    // Status + post-redirect URL appended after the body, behind a sentinel.
    args.push('-w', `${META}%{http_code}\t%{url_effective}`, url);

    const run = await runner(options.binary, args, timeoutMs);
    if (run.code !== 0) {
      throw new Error(`curl-impersonate exit ${run.code}: ${run.stderr.slice(0, 200)}`);
    }

    const text = run.stdout.toString('utf8');
    const sep = text.lastIndexOf(META);
    const rawBody = sep === -1 ? text : text.slice(0, sep);
    const meta = sep === -1 ? '' : text.slice(sep + META.length);
    const [statusStr, finalUrl] = meta.split('\t');

    const body = rawBody.length > maxBodyBytes ? rawBody.slice(0, maxBodyBytes) : rawBody;
    const setCookie = parseSetCookieLines(run.headerText);
    return {
      status: Number(statusStr) || 0,
      body,
      headers: parseHeaders(run.headerText),
      finalUrl: finalUrl?.trim() || url,
      ...(setCookie.length ? { setCookie } : {}),
    };
  };
}

/**
 * Compose a primary transport with a fallback: try `primary`, and on ANY thrown
 * error fall back to `fallback`. Used to front undici with the impersonating
 * fetcher so a missing/broken binary degrades gracefully instead of failing the
 * cycle. (A non-2xx STATUS is a normal result, not an error — only a thrown
 * transport failure triggers the fallback.)
 */
export function composeFetcher(primary: Fetcher, fallback: Fetcher): Fetcher {
  return async (url, opts) => {
    try {
      return await primary(url, opts);
    } catch (err) {
      log('impersonate').warn(
        { url, err: (err as Error).message, event: 'IMPERSONATE-FALLBACK' },
        'curl-impersonate failed — falling back to undici',
      );
      return fallback(url, opts);
    }
  };
}
