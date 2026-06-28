import { describe, it, expect } from 'vitest';
import { predictDirection } from '../src/features/pricePrediction';
import { renderNotification } from '../src/gateway/render';
import { tr } from '../src/gateway/strings';
import type { EnrichedItem, MarketInsight, Notification } from '../src/contracts';

describe('predictDirection', () => {
  it('predicts falling on repeated cuts', () => {
    expect(predictDirection({ priceCuts: 2 })).toBe('falling');
  });

  it('predicts falling on a stale listing already cut once', () => {
    expect(predictDirection({ priceCuts: 1, daysOnMarket: 45 })).toBe('falling');
  });

  it('a falling category tips a single recent cut to falling', () => {
    expect(predictDirection({ priceCuts: 1, daysOnMarket: 5 })).toBe('unknown');
    expect(predictDirection({ priceCuts: 1, daysOnMarket: 5 }, 'down')).toBe('falling');
  });

  it('predicts stable when never cut', () => {
    expect(predictDirection({ priceCuts: 0, daysOnMarket: 10 })).toBe('stable');
  });

  it('is unknown without insight', () => {
    expect(predictDirection(undefined)).toBe('unknown');
  });
});

describe('renderNotification — price outlook on a tracked alert', () => {
  const item = (): EnrichedItem => ({
    id: 'i1', title: 'Tracked', price: 1000, currency: 'EUR', url: 'https://x/1',
    isPrivateOwner: true, inStock: true, vendor: 'olx',
  });

  it('appends the falling outlook when the item keeps getting cut', () => {
    const insight: MarketInsight = { priceCuts: 3, daysOnMarket: 40 };
    const n: Notification = { kind: 'price_change', chatId: 1, item: item(), insight };
    expect(renderNotification(n, 'en').text).toContain(tr('en').price_outlook_falling);
  });

  it('appends the stable outlook when the price has never been cut', () => {
    const insight: MarketInsight = { priceCuts: 0, daysOnMarket: 8 };
    const n: Notification = { kind: 'price_change', chatId: 1, item: item(), insight };
    expect(renderNotification(n, 'en').text).toContain(tr('en').price_outlook_stable);
  });
});
