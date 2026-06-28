import { describe, it, expect } from 'vitest';
import { scamRisk } from '../src/features/scamRisk';
import { renderNotification } from '../src/gateway/render';
import { tr } from '../src/gateway/strings';
import type { EnrichedItem, FairValue, Notification } from '../src/contracts';

function item(o: Partial<EnrichedItem> = {}): EnrichedItem {
  return {
    id: 'i1', title: 'iPhone 15 Pro', price: 1000, currency: 'EUR',
    url: 'https://x/1', isPrivateOwner: true, inStock: true, vendor: 'olx',
    phone: '+40712345678', imageUrl: 'https://img/1.jpg', ...o,
  };
}

const tooGood: FairValue = { category: 'car', fair: 2000, delta: -1000, deltaPct: -0.5, confidence: 'high' };

describe('scamRisk', () => {
  it('flags a too-good price with a missing trust signal', () => {
    const r = scamRisk(item({ phone: undefined }), tooGood); // too-good + no phone
    expect(r.flagged).toBe(true);
    expect(r.reasons).toContain('too_good_price');
    expect(r.reasons).toContain('no_phone');
  });

  it('does NOT flag a cheap listing that still has phone + photo', () => {
    expect(scamRisk(item(), tooGood).flagged).toBe(false); // too-good alone (score 2) is not enough
  });

  it('does NOT flag a listing with weak signals but a fair price', () => {
    const r = scamRisk(item({ phone: undefined, imageUrl: undefined })); // no fairValue → not too-good
    expect(r.flagged).toBe(false);
  });

  it('ignores a low-confidence fair value (no false alarm on a thin model)', () => {
    const lowConf: FairValue = { ...tooGood, confidence: 'low' };
    expect(scamRisk(item({ phone: undefined }), lowConf).flagged).toBe(false);
  });
});

describe('renderNotification — scam warning on a new listing', () => {
  it('shows the scam warning when flagged', () => {
    const n: Notification = { kind: 'new_listing', chatId: 1, item: item({ phone: undefined, imageUrl: undefined }), fairValue: tooGood };
    expect(renderNotification(n, 'en').text).toContain(tr('en').scam_warn);
  });

  it('does not warn on a normal great listing', () => {
    const n: Notification = { kind: 'new_listing', chatId: 1, item: item(), fairValue: tooGood };
    expect(renderNotification(n, 'en').text).not.toContain(tr('en').scam_warn);
  });
});
