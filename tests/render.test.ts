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
