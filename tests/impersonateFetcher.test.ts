import { describe, it, expect } from 'vitest';
import {
  createImpersonateFetcher,
  composeFetcher,
  type CurlRun,
  type CurlRunner,
} from '../src/scraping/impersonateFetcher';
import type { Fetcher } from '../src/scraping/engine';

const META = '\n__AGOR_CURL_META__';

/** A runner that returns canned output and records the args it was given. */
function fakeRunner(run: Partial<CurlRun> & { onArgs?: (a: string[]) => void }): CurlRunner {
  return async (_binary, args) => {
    run.onArgs?.(args);
    return {
      code: run.code ?? 0,
      stdout: run.stdout ?? Buffer.from(''),
      headerText: run.headerText ?? '',
      stderr: run.stderr ?? '',
    };
  };
}

describe('createImpersonateFetcher', () => {
  it('parses body, status and final URL from the metadata sentinel', async () => {
    const stdout = Buffer.from(`<html>hi</html>${META}200\thttps://x.test/final`);
    const f = createImpersonateFetcher({
      binary: 'curl_chrome116',
      runner: fakeRunner({ stdout, headerText: 'HTTP/2 200\r\nserver: cloudflare\r\ncf-ray: abc\r\n' }),
    });
    const res = await f('https://x.test/start', { headers: {} });
    expect(res.body).toBe('<html>hi</html>');
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe('https://x.test/final');
    expect(res.headers).toMatchObject({ server: 'cloudflare', 'cf-ray': 'abc' });
  });

  it('parses only the final header block after redirects (lower-cased keys)', async () => {
    const headerText = 'HTTP/2 301\r\nlocation: /next\r\n\r\nHTTP/2 200\r\nServer: nginx\r\nX-Final: yes\r\n';
    const f = createImpersonateFetcher({
      binary: 'b',
      runner: fakeRunner({ stdout: Buffer.from(`body${META}200\thttps://x.test/`), headerText }),
    });
    const res = await f('https://x.test', { headers: {} });
    expect(res.headers).toEqual({ server: 'nginx', 'x-final': 'yes' });
    expect(res.headers).not.toHaveProperty('location'); // from the 301 hop, dropped
  });

  it('passes a proxy (-x) and Accept-Language but not UA/client hints', async () => {
    let seen: string[] = [];
    const f = createImpersonateFetcher({
      binary: 'b',
      runner: fakeRunner({ stdout: Buffer.from(`x${META}200\turl`), onArgs: (a) => (seen = a) }),
    });
    await f('https://x.test', {
      headers: { 'Accept-Language': 'ro-RO,ro;q=0.9', 'User-Agent': 'Chrome/124', 'sec-ch-ua': '"x"' },
      proxyUrl: 'http://user:pw@proxy:8080',
    });
    expect(seen).toContain('-x');
    expect(seen).toContain('http://user:pw@proxy:8080');
    expect(seen.join(' ')).toContain('Accept-Language: ro-RO,ro;q=0.9');
    // The binary owns these — forwarding them would defeat impersonation.
    expect(seen.join(' ')).not.toContain('User-Agent: Chrome/124');
    expect(seen.join(' ')).not.toContain('sec-ch-ua');
  });

  it('throws on a non-zero curl exit so the caller can fall back', async () => {
    const f = createImpersonateFetcher({
      binary: 'b',
      runner: fakeRunner({ code: 28, stderr: 'timeout' }),
    });
    await expect(f('https://x.test', { headers: {} })).rejects.toThrow(/exit 28/);
  });

  it('caps the body at maxBodyBytes', async () => {
    const big = 'a'.repeat(100);
    const f = createImpersonateFetcher({
      binary: 'b',
      maxBodyBytes: 10,
      runner: fakeRunner({ stdout: Buffer.from(`${big}${META}200\turl`) }),
    });
    const res = await f('https://x.test', { headers: {} });
    expect(res.body).toHaveLength(10);
  });
});

describe('composeFetcher', () => {
  it('returns the primary result when it succeeds', async () => {
    const primary: Fetcher = async () => ({ status: 200, body: 'primary' });
    const fallback: Fetcher = async () => ({ status: 200, body: 'fallback' });
    const res = await composeFetcher(primary, fallback)('https://x', { headers: {} });
    expect(res.body).toBe('primary');
  });

  it('falls back when the primary throws (e.g. missing binary)', async () => {
    const primary: Fetcher = async () => { throw new Error('ENOENT curl_chrome116'); };
    const fallback: Fetcher = async () => ({ status: 200, body: 'fallback' });
    const res = await composeFetcher(primary, fallback)('https://x', { headers: {} });
    expect(res.body).toBe('fallback');
  });

  it('does NOT fall back on a non-2xx status (that is a real result)', async () => {
    let fallbackCalled = false;
    const primary: Fetcher = async () => ({ status: 403, body: 'blocked' });
    const fallback: Fetcher = async () => { fallbackCalled = true; return { status: 200, body: 'fb' }; };
    const res = await composeFetcher(primary, fallback)('https://x', { headers: {} });
    expect(res.status).toBe(403);
    expect(fallbackCalled).toBe(false);
  });
});
