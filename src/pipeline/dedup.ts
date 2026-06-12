/**
 * Cross-platform deduplication (Feature 6).
 *
 * The same physical listing is often cross-posted to several marketplaces. We
 * collapse such duplicates so the user is notified once, with the other vendors
 * surfaced as `alternativeSources`.
 *
 * Two levels of dedup happen here:
 *  - Intra-batch: within a single cycle's results, items sharing a composite
 *    signature collapse into the FIRST occurrence; the rest become alternatives.
 *  - Cross-batch: a time-windowed buffer remembers signatures already notified
 *    in prior cycles. A re-seen listing is suppressed (not notified again), and
 *    its source is appended to the ORIGINAL alert — the buffer records the
 *    original's Telegram message so the gateway can edit it in place.
 */
import type { EnrichedItem, IScrapedItem, MessageRef } from '../contracts';
import { compositeSignature } from '../util/hash';
import type { DedupStore } from '../persistence/dedupStore';

export interface AlternativeSource {
  vendor: string;
  url: string;
}

export interface DedupEntry {
  /** Composite signature f(title, price-bucket, location). */
  signature: string;
  /** ms epoch when this signature was first recorded in the buffer. */
  firstSeenAt: number;
  /** The original representative that was (or will be) alerted; accumulates alternativeSources. */
  item: EnrichedItem;
  /** The original alert's Telegram message, once known, so cross-posts can edit it. */
  messageRef?: MessageRef;
}

/** A cross-batch duplicate: a source to append to a previously-alerted original. */
export interface CrossPost {
  entry: DedupEntry;
  source: AlternativeSource;
}

function signatureOf(item: IScrapedItem): string {
  return compositeSignature({
    title: item.title,
    price: item.price,
    location: item.location,
    id: item.id,
  });
}

/** Result of {@link collapseDuplicates}: surviving items plus cross-batch hits. */
export interface CollapseResult {
  /** Representatives to notify this cycle (cross-batch duplicates removed). */
  items: EnrichedItem[];
  /** Duplicates of a prior-cycle original; each carries the original entry to edit. */
  crossPosts: CrossPost[];
}

/** Optional persistence binding so a buffer survives process restarts. */
export interface DedupPersistence {
  store: DedupStore;
  /** The chat this buffer belongs to (the store is keyed per chat). */
  chatId: number;
}

/**
 * A time-windowed signature buffer that survives across cycles. Entries older
 * than `windowMs` are considered expired and pruned, so a listing re-appearing
 * after the window can legitimately notify again.
 *
 * When a {@link DedupPersistence} is supplied, the buffer rehydrates from it on
 * construction and writes every mutation through, so already-seen listings are
 * not re-alerted after a restart. Without it the buffer is purely in-memory
 * (the default — keeps it trivially unit-testable).
 */
export class DedupBuffer {
  private readonly entries = new Map<string, DedupEntry>();
  private readonly persistence?: DedupPersistence;

  constructor(private readonly windowMs: number, persistence?: DedupPersistence) {
    this.persistence = persistence;
    if (persistence) {
      for (const p of persistence.store.load(persistence.chatId)) {
        this.entries.set(p.signature, p.entry as DedupEntry);
      }
    }
  }

  /** Write an entry through to the backing store, if persistence is bound. */
  private persist(entry: DedupEntry): void {
    if (!this.persistence) return;
    this.persistence.store.save(this.persistence.chatId, {
      signature: entry.signature,
      firstSeenAt: entry.firstSeenAt,
      entry,
    });
  }

  /** Composite signature for an item (exposed so callers key consistently). */
  signatureOf(item: IScrapedItem): string {
    return signatureOf(item);
  }

  /** Drop entries whose age exceeds the retention window. */
  prune(now: number): void {
    for (const [sig, entry] of this.entries) {
      if (now - entry.firstSeenAt >= this.windowMs) {
        this.entries.delete(sig);
        if (this.persistence) this.persistence.store.remove(this.persistence.chatId, sig);
      }
    }
  }

  /** The live entry for a signature, if any (does not prune). */
  get(signature: string): DedupEntry | undefined {
    return this.entries.get(signature);
  }

  /** Record a brand-new representative and return its entry (cloning sources). */
  record(item: EnrichedItem, now: number): DedupEntry {
    const signature = signatureOf(item);
    const entry: DedupEntry = {
      signature,
      firstSeenAt: now,
      item: { ...item, alternativeSources: [...(item.alternativeSources ?? [])] },
    };
    this.entries.set(signature, entry);
    this.persist(entry);
    return entry;
  }

  /** Attach the original alert's Telegram message so later cross-posts can edit it. */
  setMessageRef(signature: string, ref: MessageRef): void {
    const entry = this.entries.get(signature);
    if (entry) {
      entry.messageRef = ref;
      this.persist(entry);
    }
  }

  /**
   * Replace the stored original with its enriched form (benchmark/deal tag),
   * preserving any already-accumulated alternative sources. Called after the
   * original alert is sent so a later cross-post edit re-renders the full card.
   */
  refreshOriginal(signature: string, item: EnrichedItem): void {
    const entry = this.entries.get(signature);
    if (!entry) return;
    const merged = [...(entry.item.alternativeSources ?? [])];
    for (const s of item.alternativeSources ?? []) {
      if (!merged.some((m) => m.url === s.url)) merged.push(s);
    }
    entry.item = { ...item, alternativeSources: merged };
    this.persist(entry);
  }

  /** Append an alternative source to a stored original (de-duplicated by url). */
  appendAlternative(signature: string, source: AlternativeSource): void {
    const entry = this.entries.get(signature);
    if (!entry) return;
    const sources = entry.item.alternativeSources ?? (entry.item.alternativeSources = []);
    if (!sources.some((s) => s.url === source.url)) {
      sources.push(source);
      this.persist(entry);
    }
  }

  /**
   * Back-compat lookup: if a non-expired entry exists return it (a cross-batch
   * duplicate); otherwise record this item and return `undefined`.
   */
  seen(item: IScrapedItem, now: number): DedupEntry | undefined {
    this.prune(now);
    const existing = this.entries.get(signatureOf(item));
    if (existing) return existing;
    this.record(item as EnrichedItem, now);
    return undefined;
  }
}

/**
 * Collapse duplicate enriched items.
 *
 * Within the batch, items sharing a signature collapse into the first; the rest
 * are merged in as `alternativeSources`. Across batches, if the buffer already
 * holds a prior-cycle match for the surviving item, it is suppressed AND its
 * source is appended to that original (surfaced as a {@link CrossPost} so the
 * gateway can edit the original alert block).
 */
export function collapseDuplicates(
  items: EnrichedItem[],
  buffer: DedupBuffer,
  now: number,
): CollapseResult {
  // Prune once up front so all lookups below share a consistent window.
  buffer.prune(now);

  /** Surviving representative per signature, in first-seen order. */
  const bySig = new Map<string, EnrichedItem>();
  const order: string[] = [];

  for (const item of items) {
    const signature = buffer.signatureOf(item);
    const rep = bySig.get(signature);
    if (rep === undefined) {
      bySig.set(signature, item);
      order.push(signature);
    } else {
      // Duplicate within the batch: contribute as an alternative source.
      const sources = rep.alternativeSources ?? (rep.alternativeSources = []);
      sources.push({ vendor: item.vendor ?? '', url: item.url });
    }
  }

  const out: EnrichedItem[] = [];
  const crossPosts: CrossPost[] = [];
  for (const signature of order) {
    const rep = bySig.get(signature)!;
    const existing = buffer.get(signature);
    if (existing) {
      // Cross-batch duplicate: suppress the new alert and append this source to
      // the original (so the gateway can edit the original alert block).
      const source: AlternativeSource = { vendor: rep.vendor ?? '', url: rep.url };
      buffer.appendAlternative(signature, source);
      crossPosts.push({ entry: existing, source });
    } else {
      buffer.record(rep, now);
      out.push(rep);
    }
  }
  return { items: out, crossPosts };
}
