import { describe, it, expect } from 'vitest';
import { applyExclusion, buildExclusionRegex } from '../src/pipeline/exclusionKeywords';
import type { IScrapedItem } from '../src/contracts';

function item(title: string): IScrapedItem {
  return {
    id: title,
    title,
    price: 100,
    currency: 'RON',
    url: 'https://x',
    isPrivateOwner: true,
    inStock: true,
  };
}

describe('exclusion with Romanian diacritics', () => {
  it('matches a diacritic-edged keyword as a whole word (no under-blocking)', () => {
    const re = buildExclusionRegex(['ștanță'])!;
    expect(re.test('piesa ștanță buna')).toBe(true);
    const out = applyExclusion([item('piesa ștanță buna'), item('motor bun')], ['ștanță']);
    expect(out.map((i) => i.title)).toEqual(['motor bun']);
  });

  it('does not fabricate a boundary at a diacritic suffix (no over-blocking)', () => {
    // "avariat" must NOT match the distinct word "avariată".
    const out = applyExclusion([item('mașină avariată')], ['avariat']);
    expect(out).toHaveLength(1);
    // but it should still drop the exact word "avariat"
    expect(applyExclusion([item('piesa avariat rău')], ['avariat'])).toHaveLength(0);
  });

  it('still handles ASCII keywords and metacharacters literally', () => {
    expect(applyExclusion([item('vand bmw seria 3')], ['bmw'])).toHaveLength(0);
    expect(applyExclusion([item('model bmwseria')], ['bmw'])).toHaveLength(1);
    expect(applyExclusion([item('cod a.b activ')], ['a.b'])).toHaveLength(0);
    expect(applyExclusion([item('cod axb activ')], ['a.b'])).toHaveLength(1);
  });
});
