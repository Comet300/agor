import { describe, it, expect } from 'vitest';
import type {
  EnrichedItem,
  Notification,
  PriceDropInfo,
} from '../src/contracts/index';
import { formatMoney } from '../src/util/money';
import { draftOffer } from '../src/features/contactOffer';
import {
  renderNotification,
  renderRegistrationCard,
  type RenderedMessage,
} from '../src/gateway/render';
import { tr } from '../src/gateway/strings';

/** Minimal enriched-item factory; tests override only what they assert on. */
function makeItem(overrides: Partial<EnrichedItem> = {}): EnrichedItem {
  return {
    id: 'i1',
    title: 'VW Golf 5 1.9 TDI',
    price: 4300,
    currency: 'RON',
    url: 'https://olx.ro/d/oferta/i1',
    isPrivateOwner: true,
    inStock: true,
    vendor: 'olx.ro',
    ...overrides,
  };
}

/** Flatten the keyboard into its buttons for easy assertions. */
function buttons(msg: RenderedMessage) {
  return msg.keyboard!.inline_keyboard.flat();
}

describe('renderNotification — new_listing', () => {
  it('renders a rich card with title, price, deal badge, buttons and offer', () => {
    const item = makeItem({
      title: 'BMW E46 320d',
      price: 4300,
      currency: 'EUR',
      phone: '+40 712 345 678',
      dealTag: 'great_deal',
    });
    const n: Notification = { kind: 'new_listing', chatId: 99, item };

    const msg = renderNotification(n, 'en');

    // Title + formatted price.
    expect(msg.text).toContain('BMW E46 320d');
    expect(msg.text).toContain(formatMoney(item.price, item.currency)); // "4 300 EUR"

    // Deal badge for a great_deal item (EN copy from the catalog).
    expect(msg.text).toContain(tr('en').badge_great_deal);

    // The offer draft (already backtick-wrapped) is appended verbatim.
    expect(msg.text).toContain(draftOffer(item, 'en'));

    // Open URL button to the listing.
    const btns = buttons(msg);
    const open = btns.find((b) => 'url' in b && b.url === item.url);
    expect(open).toBeDefined();

    // Call button present (phone supplied) -> a tel: deep link.
    const call = btns.find((b) => 'url' in b && b.url.startsWith('tel:'));
    expect(call).toBeDefined();
    expect((call as { url: string }).url).toBe('tel:+40712345678');

    // Price-history callback button keyed by vendor + id.
    const pg = btns.find((b) => 'callback_data' in b && b.callback_data.startsWith('pg:'));
    expect(pg).toBeDefined();
    expect((pg as { callback_data: string }).callback_data).toBe('pg:olx.ro:i1');
  });

  it('omits the call button when no phone is present', () => {
    const item = makeItem({ phone: undefined });
    const msg = renderNotification({ kind: 'new_listing', chatId: 1, item }, 'en');

    const call = buttons(msg).find((b) => 'url' in b && b.url.startsWith('tel:'));
    expect(call).toBeUndefined();
  });

  it('appends an "Also on:" line when alternativeSources are present', () => {
    const item = makeItem({
      alternativeSources: [{ vendor: 'autovit.ro', url: 'https://autovit.ro/x' }],
    });
    const msg = renderNotification({ kind: 'new_listing', chatId: 1, item }, 'en');

    expect(msg.text).toContain('Also on:');
    expect(msg.text).toContain('autovit.ro');
  });

  it('renders specs, posted date, and a description snippet when present', () => {
    const item = makeItem({
      attributes: { km: '40 400 km', fuel: 'Electric', year: '2023' },
      postedAt: Date.parse('2026-06-09T16:21:42+03:00'),
      description: 'Tesla Model 3 in impeccable condition, single owner, full service history.',
    });
    const n: Notification = { kind: 'new_listing', chatId: 1, item };
    const msg = renderNotification(n, 'en');
    expect(msg.text).toContain('km: 40 400 km');
    expect(msg.text).toContain('fuel: Electric');
    expect(msg.text).toContain('Posted: 2026-06-09');
    expect(msg.text).toContain('single owner');
  });

  it('caps specs to 5 and truncates a long description', () => {
    const attributes: Record<string, string> = {};
    for (let i = 0; i < 9; i++) attributes[`k${i}`] = `v${i}`;
    const item = makeItem({
      attributes,
      description: 'x'.repeat(400),
    });
    const msg = renderNotification({ kind: 'new_listing', chatId: 1, item }, 'en');
    const specsLine = msg.text.split('\n').find((l) => l.startsWith('📋'))!;
    expect((specsLine.match(/·/g) ?? []).length).toBe(4); // 5 specs -> 4 separators
    expect(msg.text).toContain('…'); // description truncated
  });

  it('omits the new lines entirely when the item has no specs/date/description', () => {
    const msg = renderNotification({ kind: 'new_listing', chatId: 1, item: makeItem() }, 'en');
    expect(msg.text).not.toContain('📋');
    expect(msg.text).not.toContain('Posted:');
  });
});

describe('renderNotification — price_drop', () => {
  it('shows old price, new price and savings', () => {
    const item = makeItem({ price: 3800, currency: 'RON' });
    const priceDrop: PriceDropInfo = {
      previousPrice: 4300,
      currentPrice: 3800,
      savings: 500,
    };
    const msg = renderNotification(
      {
        kind: 'price_drop',
        chatId: 7,
        item,
        priceDrop,
      },
      'en',
    );

    expect(msg.text).toContain(formatMoney(4300, 'RON')); // old
    expect(msg.text).toContain(formatMoney(3800, 'RON')); // new
    expect(msg.text).toContain(formatMoney(500, 'RON')); // savings
  });
});

describe('renderNotification — back_in_stock', () => {
  it('shows the BACK IN STOCK banner', () => {
    const item = makeItem({ inStock: true });
    const msg = renderNotification({ kind: 'back_in_stock', chatId: 3, item }, 'en');

    expect(msg.text).toContain(tr('en').back_in_stock_title);
    expect(msg.text).toContain(item.title);
  });
});

describe('renderRegistrationCard', () => {
  it('exposes sv / fq / ex / rm / go callback buttons', () => {
    const msg = renderRegistrationCard(
      {
        monitorId: 42,
        vendor: 'olx.ro',
        summary: 'https://olx.ro/search?q=golf',
        baselineCount: 12,
        sellerVisibility: 'both',
        intervalMinutes: 10,
      },
      'en',
    );

    const data = buttons(msg)
      .filter((b) => 'callback_data' in b)
      .map((b) => (b as { callback_data: string }).callback_data);

    // Seller visibility — all three options.
    expect(data).toContain('sv:42:private');
    expect(data).toContain('sv:42:company');
    expect(data).toContain('sv:42:both');
    // Frequency presets + exclusion prompt + remove + go-live.
    expect(data).toContain('fq:42:5');
    expect(data).toContain('fq:42:60');
    expect(data).toContain('ex:42');
    expect(data).toContain('rm:42');
    expect(data).toContain('go:42');
  });

  it('uses EN copy and marks the active frequency preset', () => {
    const msg = renderRegistrationCard(
      {
        monitorId: 42,
        vendor: 'olx.ro',
        summary: 'https://olx.ro/search?q=golf',
        baselineCount: 1,
        sellerVisibility: 'private',
        intervalMinutes: 30,
      },
      'en',
    );

    expect(msg.text).toContain(tr('en').reg_watching('olx.ro'));
    expect(msg.text).toContain(tr('en').reg_baseline(1));

    const labels = buttons(msg).map((b) => ('text' in b ? b.text : ''));
    expect(labels).toContain(`✅ ${tr('en').btn_freq(30)}`);
    expect(labels).toContain(`✅ ${tr('en').btn_private}`);
  });
});

describe('renderNotification — browse/track/de-listing kinds', () => {
  it('price_change shows old→new and a down arrow for a drop', () => {
    const item = makeItem({ price: 4000, currency: 'EUR' });
    const msg = renderNotification(
      { kind: 'price_change', chatId: 1, item,
        priceChange: { previousPrice: 5000, currentPrice: 4000, direction: 'down' } },
      'en',
    );
    expect(msg.text).toContain('📉');
    expect(msg.text).toContain(formatMoney(5000, 'EUR'));
    expect(msg.text).toContain(formatMoney(4000, 'EUR'));
    expect(buttons(msg).length).toBeGreaterThan(0); // keeps quick actions
  });

  it('price_change shows an up arrow for an increase', () => {
    const item = makeItem({ price: 5500, currency: 'EUR' });
    const msg = renderNotification(
      { kind: 'price_change', chatId: 1, item,
        priceChange: { previousPrice: 5000, currentPrice: 5500, direction: 'up' } },
      'en',
    );
    expect(msg.text).toContain('📈');
  });

  it('item_delisted (product_gone) renders the reason + Open-only keyboard', () => {
    const item = makeItem({ phone: '+40712345678' });
    const msg = renderNotification(
      { kind: 'item_delisted', chatId: 1, item, delist: { reason: 'product_gone', lastSeenPrice: 4300 } },
      'en',
    );
    expect(msg.text).toContain(tr('en').delisted_title);
    expect(msg.text).toContain(tr('en').delisted_reason_product_gone);
    expect(msg.text).toContain(formatMoney(4300, 'RON'));
    // Only the Open link — no Call / Price-history even though a phone exists.
    const b = buttons(msg);
    expect(b).toHaveLength(1);
    expect('url' in b[0]!).toBe(true);
  });

  it('item_delisted (search_dropped) renders the search reason', () => {
    const msg = renderNotification(
      { kind: 'item_delisted', chatId: 1, item: makeItem(), delist: { reason: 'search_dropped' } },
      'en',
    );
    expect(msg.text).toContain(tr('en').delisted_reason_search_dropped);
  });

  it('listings_dropped renders a count header and sample titles, no keyboard', () => {
    const msg = renderNotification(
      { kind: 'listings_dropped', chatId: 1,
        dropped: { monitorId: 7, vendor: 'olx.ro', count: 3, titles: ['Golf', 'Passat', 'Octavia'] } },
      'en',
    );
    expect(msg.text).toContain('3');
    expect(msg.text).toContain('olx.ro');
    expect(msg.text).toContain('Golf');
    expect(msg.keyboard).toBeUndefined(); // button-less summary
  });

  it('re_listed renders a reappear card with quick actions', () => {
    const item = makeItem({ title: 'Back again', location: 'Cluj' });
    const msg = renderNotification({ kind: 're_listed', chatId: 1, item }, 'en');
    expect(msg.text).toContain(tr('en').re_listed_title);
    expect(msg.text).toContain('Back again');
    expect(buttons(msg).length).toBeGreaterThan(0);
  });

  it('became_deal renders the title + price + rating line', () => {
    const item = makeItem({ title: 'Now a steal', price: 9000, currency: 'EUR' });
    const msg = renderNotification(
      { kind: 'became_deal', chatId: 1, item, becameDeal: { percentile: 0.1, n: 18 } },
      'en',
    );
    expect(msg.text).toContain(tr('en').became_deal_title);
    expect(msg.text).toContain('Now a steal');
    expect(msg.text).toMatch(/cheaper than/i);
    expect(buttons(msg).length).toBeGreaterThan(0);
  });

  it('target_hit renders the target reached + price with quick actions', () => {
    const item = makeItem({ title: 'Bargain', price: 11500, currency: 'EUR' });
    const msg = renderNotification(
      { kind: 'target_hit', chatId: 1, item, target: { targetPrice: 12000, currentPrice: 11500 } },
      'en',
    );
    expect(msg.text).toContain(tr('en').target_hit_title);
    expect(msg.text).toContain(formatMoney(11500, 'EUR'));
    expect(msg.text).toContain(formatMoney(12000, 'EUR')); // the target
    expect(buttons(msg).length).toBeGreaterThan(0);
  });
});

describe('renderBrowseCard', () => {
  const snap = {
    monitorId: 1, itemId: 'snap', inStock: true, lastPrice: 12500, currency: 'EUR',
    firstSeen: 1, lastSeen: 2,
    title: 'VW Golf 7', url: 'https://www.olx.ro/d/snap', imageUrl: 'https://img/snap.jpg',
    location: 'Cluj-Napoca', sellerPrivate: true, postedAt: 1_700_000_000_000,
    description: 'Stare excelenta',
    attributes: { year: '2016', km: '145000', fuel: 'Diesel' },
  };

  it('renders a full card with photo, bullets, position and a carousel keyboard', async () => {
    const { renderBrowseCard } = await import('../src/gateway/render');
    const view = renderBrowseCard(snap, 2, 37, 'en');

    expect(view.text).toContain('VW Golf 7');
    expect(view.text).toContain(formatMoney(12500, 'EUR'));
    expect(view.text).toContain('year: 2016');          // attribute bullets
    expect(view.text).toContain('Cluj-Napoca');
    expect(view.text).toContain('2023-11');             // posted date (from postedAt)
    expect(view.text).toContain('item 3 of 37');        // 0-based index 2 → "3 of 37"
    expect(view.photoUrl).toBe('https://img/snap.jpg'); // image surfaced for a photo send

    // Carousel: Prev (idx>0), Track, Next (idx<total-1) on row 1; Open on row 2.
    const flat = view.keyboard!.inline_keyboard.flat();
    const datas = flat.map((b) => ('callback_data' in b ? b.callback_data : `url:${'url' in b ? b.url : ''}`));
    expect(datas).toContain('br:1'); // Prev → index-1
    expect(datas).toContain('tk:2'); // Track → this index
    expect(datas).toContain('br:3'); // Next → index+1
    expect(datas.some((d) => d.startsWith('url:https://www.olx.ro/d/snap'))).toBe(true);
  });

  it('omits Prev at the first item and Next at the last', async () => {
    const { renderBrowseCard } = await import('../src/gateway/render');
    const first = renderBrowseCard(snap, 0, 3, 'en').keyboard!.inline_keyboard.flat()
      .map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(first).not.toContain('br:-1');     // no Prev at index 0
    expect(first).toContain('br:1');          // Next present

    const last = renderBrowseCard(snap, 2, 3, 'en').keyboard!.inline_keyboard.flat()
      .map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(last).toContain('br:1');           // Prev present
    expect(last.some((d) => d.startsWith('br:3'))).toBe(false); // no Next past the end
  });

  it('renders a legacy snapshot (no metadata) without throwing and without a photo', async () => {
    const { renderBrowseCard } = await import('../src/gateway/render');
    const bare = { monitorId: 1, itemId: 'x', inStock: true, lastPrice: 100, currency: 'RON', firstSeen: 1, lastSeen: 2 };
    const view = renderBrowseCard(bare, 0, 1, 'en');
    expect(view.text).toContain('x');         // falls back to itemId for the title
    expect(view.photoUrl).toBeUndefined();
  });
});
