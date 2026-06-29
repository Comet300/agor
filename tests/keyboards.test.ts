import { describe, it, expect } from 'vitest';
import {
  registrationKeyboard,
  editKeyboard,
  browseKeyboard,
  browseScopeKeyboard,
  browseScopeLabel,
  pickerKeyboard,
  frequencyPickerKeyboard,
  homeKeyboard,
  langPickerKeyboard,
  sellerMenuKeyboard,
  reportsMenuKeyboard,
  type PickerSession,
} from '../src/gateway/keyboards';
import { tr } from '../src/gateway/strings';
import type { Monitor } from '../src/contracts';

function monitor(over: Partial<Monitor> = {}): Monitor {
  return {
    id: 4, type: 'search', origin: 'user', chatId: 1, vendor: 'OLX',
    url: 'https://www.olx.ro/auto/q-golf/',
    filters: { sellerVisibility: 'both', exclusionKeywords: [] },
    intervalMs: 600000, fastTier: false, nextDueAt: 0, consecutiveFailures: 0, paused: false, createdAt: 0,
    ...over,
  };
}

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

describe('registrationKeyboard check-interval', () => {
  it('collapses the presets behind one interval button showing the current value', () => {
    const kb = registrationKeyboard(7, 'en', 'both', 30);
    expect(data(kb)).toContain('fqi:7');          // opens the freq picker
    expect(labels(kb)).toContain(tr('en').btn_interval('30m')); // current shown
    expect(data(kb)).not.toContain('fq:7:5');     // presets no longer on the card
    expect(data(kb)).toContain('rm:7');
  });

  it('the freq picker lists every preset (scoped fq:/efq:) with the active one marked, + back', () => {
    const reg = frequencyPickerKeyboard(7, 30, 'en', 'reg');
    expect(data(reg)).toContain('fq:7:5');
    expect(data(reg)).toContain('fq:7:60');
    expect(labels(reg)).toContain(`✅ ${tr('en').btn_freq(30)}`); // active marked
    expect(data(reg)).toContain('fqb:7'); // back to the card

    const edit = frequencyPickerKeyboard(9, 5, 'en', 'edit');
    expect(data(edit)).toContain('efq:9:5');
    expect(data(edit)).toContain('efb:9');
  });

  it('offers grouping straight from the confirm card (reuses the egr: flow)', () => {
    const kb = registrationKeyboard(7, 'en');
    expect(data(kb)).toContain('egr:7');
    expect(labels(kb)).toContain(tr('en').btn_group);
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

describe('editKeyboard', () => {
  const dataOf = (kb: ReturnType<typeof editKeyboard>): string[] =>
    kb.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : `url:${'url' in b ? b.url : ''}`));

  it('search watch: seller + interval + exclusion + rename + pause + remove + done, no Start', () => {
    const d = dataOf(editKeyboard(monitor({ id: 4, type: 'search' }), 'en'));
    expect(d).toContain('esm:4');          // seller submenu opener (options behind it)
    expect(d.some((x) => x.startsWith('esv:'))).toBe(false); // seller options are behind esm now
    expect(d).toContain('efi:4');          // check-interval button (opens the freq picker)
    expect(d.some((x) => x.startsWith('efq:'))).toBe(false); // presets are behind the picker now
    expect(d).toContain('ex:4');           // exclusion (reuses registration callback)
    expect(d).toContain('eq:4');           // required keywords
    expect(d).toContain('eb:4');           // block seller
    expect(d).toContain('er:4');           // rename
    expect(d).toContain('ep:4');           // pause/resume
    expect(d).toContain('rm:4');           // remove
    expect(d).toContain('ed');             // done
    expect(d.some((x) => x.startsWith('et:'))).toBe(false); // target price is product-only
    expect(d.some((x) => x.startsWith('go:'))).toBe(false); // no "Start" on an existing watch
  });

  it('product watch: interval + target + rename + pause + remove + done (no seller / exclusion)', () => {
    const d = dataOf(editKeyboard(monitor({ id: 9, type: 'product', origin: 'tracked' }), 'en'));
    expect(d).toContain('efi:9');          // check-interval button
    expect(d).toContain('et:9');           // target price (product only)
    expect(d).toContain('er:9');           // rename works for any watch
    expect(d).toContain('ep:9');           // pause works for any watch
    expect(d).toContain('rm:9');
    expect(d).toContain('ed');
    expect(d.some((x) => x.startsWith('esv:'))).toBe(false); // seller filter N/A to one listing
    expect(d.some((x) => x.startsWith('ex:'))).toBe(false);  // exclusions N/A
    expect(d.some((x) => x.startsWith('eq:'))).toBe(false);  // required keywords N/A
    expect(d.some((x) => x.startsWith('eb:'))).toBe(false);  // block seller N/A
    expect(d.some((x) => x.startsWith('go:'))).toBe(false);
  });

  it('pause button label flips to Resume when the watch is paused', () => {
    const labelsOf = (m: Monitor): string[] =>
      editKeyboard(m, 'en').inline_keyboard.flat().map((b) => ('text' in b ? b.text : ''));
    expect(labelsOf(monitor({ paused: false }))).toContain(tr('en').btn_pause);
    expect(labelsOf(monitor({ paused: true }))).toContain(tr('en').btn_resume);
  });

  it('shows the active seller and the current interval on the card', () => {
    const labels = (m: Monitor): string[] =>
      editKeyboard(m, 'en').inline_keyboard.flat().map((b) => ('text' in b ? b.text : ''));
    const l = labels(monitor({ intervalMs: 30 * 60000, filters: { sellerVisibility: 'private', exclusionKeywords: [] } }));
    expect(l).toContain(tr('en').btn_interval('30m')); // current interval on the collapsed button
    expect(l).toContain(tr('en').btn_seller_menu(tr('en').btn_private)); // seller opener shows current value
  });

  it('seller submenu lists the 3 options with the active one ticked + a back button', () => {
    const d = dataOf(sellerMenuKeyboard(monitor({ id: 7, type: 'search', filters: { sellerVisibility: 'company', exclusionKeywords: [] } }), 'en'));
    expect(d).toContain('esv:7:private');
    expect(d).toContain('esv:7:company');
    expect(d).toContain('esv:7:both');
    expect(d).toContain('efb:7'); // back to the edit card
    const l = sellerMenuKeyboard(monitor({ id: 7, type: 'search', filters: { sellerVisibility: 'company', exclusionKeywords: [] } }), 'en')
      .inline_keyboard.flat().map((b) => ('text' in b ? b.text : ''));
    expect(l).toContain(`✅ ${tr('en').btn_company}`);
  });

  it('language picker lists all 6 langs (active ticked) + back to home, via setlang', () => {
    const d = dataOf(langPickerKeyboard('de'));
    for (const code of ['ro', 'en', 'de', 'fr', 'it', 'es']) expect(d).toContain(`setlang:${code}`);
    expect(d).toContain('idx:home'); // back arrow returns to the index
    const l = langPickerKeyboard('de').inline_keyboard.flat().map((b) => ('text' in b ? b.text : ''));
    expect(l).toContain(`✅ ${tr('de').lang_name}`); // active language is ticked
    expect(l).toContain(tr('ro').lang_name); // each shown in its own name
  });

  it('reports submenu has digest + report toggles and a back button', () => {
    const d = dataOf(reportsMenuKeyboard(monitor({ id: 8, type: 'search' }), 'en'));
    expect(d).toContain('edg:8'); // digest cycle
    expect(d).toContain('erp:8'); // weekly report toggle
    expect(d).toContain('efb:8'); // back to the edit card
  });
});

describe('pickerKeyboard', () => {
  const dataOf = (kb: ReturnType<typeof pickerKeyboard>): string[] =>
    kb.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : ''));
  const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `opt${i}`, value: String(i) }));

  it('paginates at 15 per page with Prev/Next', () => {
    const s: PickerSession = { kind: 'exclude', prompt: 'pick', monitorId: 1, options: opts(20), page: 0, allowType: true };
    const d = dataOf(pickerKeyboard(s, 'en'));
    expect(d.filter((x) => x.startsWith('ki:')).length).toBe(15); // first page = 15 items
    expect(d).toContain('kp:1');   // Next
    expect(d).not.toContain('kp:-1');
    expect(d).toContain('kt');     // Type
    expect(d).toContain('kc');     // Done

    const d2 = dataOf(pickerKeyboard({ ...s, page: 1 }, 'en'));
    expect(d2.filter((x) => x.startsWith('ki:')).length).toBe(5); // second page = remaining 5
    expect(d2).toContain('kp:0');  // Prev
  });

  it('marks selected options and omits Type when not allowed', () => {
    const s: PickerSession = { kind: 'command', command: 'edit', prompt: 'pick', monitorId: 0, options: [{ label: 'A', value: '1', selected: true }], page: 0, allowType: false };
    const kb = pickerKeyboard(s, 'en');
    const labels = kb.inline_keyboard.flat().map((b) => ('text' in b ? b.text : ''));
    expect(labels.some((l) => l.startsWith('✅'))).toBe(true);
    expect(dataOf(kb)).not.toContain('kt');
    expect(dataOf(kb)).toContain('kc');
  });
});


describe('homeKeyboard (/start index)', () => {
  it('routes core actions, and shows Request access only when not allowed', () => {
    const allowed = homeKeyboard('en', true);
    const dAllowed = allowed.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(dAllowed).toEqual(expect.arrayContaining(['idx:list', 'idx:browse', 'idx:saved', 'idx:stats', 'idx:lang', 'idx:help']));
    expect(dAllowed).not.toContain('idx:access'); // already allowed → no request button

    const guest = homeKeyboard('en', false);
    const dGuest = guest.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(dGuest).toContain('idx:access'); // not allowed → offer request access
  });
});
