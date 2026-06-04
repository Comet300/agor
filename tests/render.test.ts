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
  return msg.keyboard.inline_keyboard.flat();
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

    const msg = renderNotification(n);

    // Title + formatted price.
    expect(msg.text).toContain('BMW E46 320d');
    expect(msg.text).toContain(formatMoney(item.price, item.currency)); // "4 300 EUR"

    // Deal badge for a great_deal item.
    expect(msg.text).toContain('🔥 Great Deal');

    // The offer draft (already backtick-wrapped) is appended verbatim.
    expect(msg.text).toContain(draftOffer(item));

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
    const msg = renderNotification({ kind: 'new_listing', chatId: 1, item });

    const call = buttons(msg).find((b) => 'url' in b && b.url.startsWith('tel:'));
    expect(call).toBeUndefined();
  });

  it('appends an "Also on:" line when alternativeSources are present', () => {
    const item = makeItem({
      alternativeSources: [{ vendor: 'autovit.ro', url: 'https://autovit.ro/x' }],
    });
    const msg = renderNotification({ kind: 'new_listing', chatId: 1, item });

    expect(msg.text).toContain('Also on:');
    expect(msg.text).toContain('autovit.ro');
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
    const msg = renderNotification({
      kind: 'price_drop',
      chatId: 7,
      item,
      priceDrop,
    });

    expect(msg.text).toContain(formatMoney(4300, 'RON')); // old
    expect(msg.text).toContain(formatMoney(3800, 'RON')); // new
    expect(msg.text).toContain(formatMoney(500, 'RON')); // savings
  });
});

describe('renderNotification — back_in_stock', () => {
  it('shows the BACK IN STOCK banner', () => {
    const item = makeItem({ inStock: true });
    const msg = renderNotification({ kind: 'back_in_stock', chatId: 3, item });

    expect(msg.text).toContain('🟢 BACK IN STOCK');
    expect(msg.text).toContain(item.title);
  });
});

describe('renderRegistrationCard', () => {
  it('exposes sv / ex / go callback buttons', () => {
    const msg = renderRegistrationCard({
      monitorId: 42,
      vendor: 'olx.ro',
      summary: 'https://olx.ro/search?q=golf',
      baselineCount: 12,
    });

    const data = buttons(msg)
      .filter((b) => 'callback_data' in b)
      .map((b) => (b as { callback_data: string }).callback_data);

    // Seller visibility — all three options.
    expect(data).toContain('sv:42:private');
    expect(data).toContain('sv:42:company');
    expect(data).toContain('sv:42:both');
    // Exclusion prompt + go-live.
    expect(data).toContain('ex:42');
    expect(data).toContain('go:42');
  });
});
