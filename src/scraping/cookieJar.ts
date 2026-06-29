/**
 * Per-vendor cookie/session persistence — a translation of Scrapling's
 * session idea (FetcherSession / StealthySession) into our stateless transports.
 *
 * Without this, every poll is a fresh request: when a vendor's edge (Cloudflare)
 * hands back a `cf_clearance` cookie after a challenge pass, we throw it away and
 * re-run the challenge next cycle. A jar keyed by the vendor's registered domain
 * lets that clearance cookie — and any other session cookie — ride subsequent
 * polls across ALL transports (undici, curl-impersonate, and the headless
 * browser), so the browser challenge is paid once and reused, and we look like a
 * returning visitor rather than a first-touch bot every time.
 *
 * The jar is transport-agnostic: it ingests RFC `Set-Cookie` header lines and
 * emits a `Cookie` request-header value. Expiry (Max-Age / Expires) is honoured;
 * cookies with no expiry are kept as session cookies until overwritten. An
 * optional {@link CookiePersistence} backs it with SQLite so a cleared session
 * survives a restart.
 */

/** One stored cookie value, with an optional absolute expiry (epoch ms). */
export interface StoredCookie {
  value: string;
  expiresAt?: number;
}

/** Per-domain cookie map: name → stored cookie. */
export type DomainJar = Record<string, StoredCookie>;

/** Durable backing for the jar (SQLite in production; omitted in tests). */
export interface CookiePersistence {
  load(domain: string): DomainJar | undefined;
  save(domain: string, jar: DomainJar): void;
}

/** Parse one `Set-Cookie` line into a name/value (+ expiry). */
export function parseSetCookie(line: string, now: number): { name: string; value: string; expiresAt?: number } | undefined {
  const segments = line.split(';');
  const first = (segments[0] ?? '').trim();
  const eq = first.indexOf('=');
  if (eq <= 0) return undefined; // no name → not a cookie
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  let expiresAt: number | undefined;
  for (const seg of segments.slice(1)) {
    const idx = seg.indexOf('=');
    const key = (idx === -1 ? seg : seg.slice(0, idx)).trim().toLowerCase();
    const v = idx === -1 ? '' : seg.slice(idx + 1).trim();
    if (key === 'max-age') {
      const secs = Number(v);
      if (Number.isFinite(secs)) expiresAt = now + secs * 1000; // Max-Age wins over Expires
    } else if (key === 'expires' && expiresAt === undefined) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) expiresAt = t;
    }
  }
  return expiresAt === undefined ? { name, value } : { name, value, expiresAt };
}

export class CookieJar {
  private readonly mem = new Map<string, DomainJar>();

  constructor(private readonly persist?: CookiePersistence) {}

  private jarFor(domain: string): DomainJar {
    let jar = this.mem.get(domain);
    if (!jar) {
      jar = this.persist?.load(domain) ?? {};
      this.mem.set(domain, jar);
    }
    return jar;
  }

  /** Build the `Cookie` request header for `domain`, dropping expired entries. */
  cookieHeader(domain: string, now: number): string {
    const jar = this.jarFor(domain);
    const parts: string[] = [];
    let changed = false;
    for (const [name, cookie] of Object.entries(jar)) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        delete jar[name];
        changed = true;
        continue;
      }
      parts.push(`${name}=${cookie.value}`);
    }
    if (changed) this.persist?.save(domain, jar);
    return parts.join('; ');
  }

  /** Merge `Set-Cookie` header lines from a response into `domain`'s jar. */
  ingestSetCookie(domain: string, lines: readonly string[] | undefined, now: number): void {
    if (!lines || lines.length === 0) return;
    const jar = this.jarFor(domain);
    let changed = false;
    for (const line of lines) {
      const parsed = parseSetCookie(line, now);
      if (!parsed) continue;
      // A cookie set in the past is a deletion.
      if (parsed.expiresAt !== undefined && parsed.expiresAt <= now) {
        if (jar[parsed.name]) { delete jar[parsed.name]; changed = true; }
        continue;
      }
      jar[parsed.name] = parsed.expiresAt === undefined
        ? { value: parsed.value }
        : { value: parsed.value, expiresAt: parsed.expiresAt };
      changed = true;
    }
    if (changed) this.persist?.save(domain, jar);
  }

  /** Snapshot of the live (non-expired) name=value pairs for `domain`. */
  pairs(domain: string, now: number): { name: string; value: string }[] {
    const header = this.cookieHeader(domain, now);
    if (!header) return [];
    return header.split('; ').map((p) => {
      const eq = p.indexOf('=');
      return { name: p.slice(0, eq), value: p.slice(eq + 1) };
    });
  }
}
