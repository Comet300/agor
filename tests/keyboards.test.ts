import { describe, it, expect } from 'vitest';
import {
  registrationKeyboard,
  browseKeyboard,
  browseScopeKeyboard,
  browseScopeLabel,
} from '../src/gateway/keyboards';
import { tr } from '../src/gateway/strings';

function labels(kb: ReturnType<typeof registrationKeyboard>): string[] {
  return kb.inline_keyboard.flat().map((b) => ('text' in b ? b.text : ''));
}

function data(kb: ReturnType<typeof registrationKeyboard>): string[] {
  return kb.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : ''));
}

describe('registrationKeyboard seller-visibility state', () => {
  it('marks the active seller option with a check (EN labels)', () => {
    const priv = labels(registrationKeyboard(7, 'en', 'private'));
    expect(priv).toContain(`✅ ${tr('en').btn_private}`);
    expect(priv).toContain(tr('en').btn_company); // others unmarked
    expect(priv).toContain(tr('en').btn_both);
  });

  it('defaults to marking "Both"', () => {
    expect(labels(registrationKeyboard(7, 'en'))).toContain(`✅ ${tr('en').btn_both}`);
  });

  it('produces a real markup diff between visibilities (avoids Telegram 400 not-modified)', () => {
    const a = JSON.stringify(registrationKeyboard(7, 'en', 'private').inline_keyboard);
    const b = JSON.stringify(registrationKeyboard(7, 'en', 'company').inline_keyboard);
    expect(a).not.toBe(b);
  });

  it('keeps callback_data stable regardless of the active marker', () => {
    const kb = registrationKeyboard(7, 'en', 'company');
    const d = data(kb);
    expect(d).toContain('sv:7:private');
    expect(d).toContain('sv:7:company');
    expect(d).toContain('sv:7:both');
    expect(d).toContain('go:7');
  });
});

describe('registrationKeyboard frequency presets', () => {
  it('marks the active frequency preset with a check', () => {
    const lbls = labels(registrationKeyboard(7, 'en', 'both', 30));
    expect(lbls).toContain(`✅ ${tr('en').btn_freq(30)}`);
    expect(lbls).toContain(tr('en').btn_freq(5)); // others unmarked
  });

  it('exposes fq/rm callback data for every preset', () => {
    const d = data(registrationKeyboard(7, 'en'));
    expect(d).toContain('fq:7:5');
    expect(d).toContain('fq:7:10');
    expect(d).toContain('fq:7:30');
    expect(d).toContain('fq:7:60');
    expect(d).toContain('rm:7');
  });
});

describe('registrationKeyboard localization', () => {
  it('differs in labels by language but keeps callback data identical', () => {
    const en = registrationKeyboard(7, 'en', 'private', 10);
    const ro = registrationKeyboard(7, 'ro', 'private', 10);

    // Labels differ (RO copy != EN copy somewhere).
    expect(labels(en)).not.toEqual(labels(ro));

    // Callback data is byte-for-byte identical.
    expect(data(en)).toEqual(data(ro));
  });
});

describe('browseKeyboard nav affordances', () => {
  const dataOf = (kb: ReturnType<typeof browseKeyboard>): string[] =>
    kb.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : `url:${'url' in b ? b.url : ''}`));

  it('offers Jump when there is more than one item, omits it for a single item', () => {
    expect(dataOf(browseKeyboard(0, 5, 'https://x/0', 'en'))).toContain('bj');
    expect(dataOf(browseKeyboard(0, 1, 'https://x/0', 'en'))).not.toContain('bj');
  });

  it('shows Switch only when canSwitch is set', () => {
    expect(dataOf(browseKeyboard(2, 9, 'https://x/2', 'en', true))).toContain('bw');
    expect(dataOf(browseKeyboard(2, 9, 'https://x/2', 'en', false))).not.toContain('bw');
  });

  it('keeps Prev/Next/Track/Open intact alongside the new buttons', () => {
    const d = dataOf(browseKeyboard(2, 9, 'https://x/2', 'en', true));
    expect(d).toContain('br:1');  // Prev
    expect(d).toContain('br:3');  // Next
    expect(d).toContain('tk:2');  // Track
    expect(d.some((x) => x.startsWith('url:https://x/2'))).toBe(true); // Open
  });

  it('omits the Open button when the item has no url (legacy snapshot)', () => {
    // Telegram rejects an empty-url button (BUTTON_URL_INVALID) and fails the whole
    // send — a url-less row must simply drop Open, not crash the card.
    const d = dataOf(browseKeyboard(3, 9, '', 'en', true));
    expect(d.some((x) => x.startsWith('url:'))).toBe(false);
    expect(d).toContain('tk:3'); // the rest of the card is intact
    expect(d).toContain('bj');
  });
});

describe('browseScopeKeyboard / browseScopeLabel', () => {
  it('renders All first, then one bs: button per scope with counts in the label', () => {
    const kb = browseScopeKeyboard(
      [
        { target: 'all', label: '📂 All', count: 42 },
        { target: 7, label: 'olx · golf', count: 27 },
      ],
      'en',
    );
    const cell = (r: number): { data: string; text: string } => {
      const b = kb.inline_keyboard[r]![0]!;
      return { data: 'callback_data' in b ? b.callback_data : '', text: 'text' in b ? b.text : '' };
    };
    expect(cell(0).data).toBe('bs:all');
    expect(cell(0).text).toContain('(42)');
    expect(cell(1).data).toBe('bs:7');
    expect(cell(1).text).toContain('(27)');
  });

  it('derives a vendor · query hint from a q-<slug> path or query param', () => {
    expect(browseScopeLabel('olx', 'https://www.olx.ro/auto/q-suzuki-swace-hibrid/')).toBe('olx · suzuki swace hibrid');
    expect(browseScopeLabel('vinted', 'https://vinted.ro/catalog?q=iphone+13')).toBe('vinted · iphone 13');
  });

  it('falls back to the vendor alone when no hint is recognisable', () => {
    expect(browseScopeLabel('olx', 'https://www.olx.ro/auto/')).toBe('olx');
    expect(browseScopeLabel('olx', 'not a url')).toBe('olx');
  });
});
