import { describe, it, expect } from 'vitest';
import { registrationKeyboard } from '../src/gateway/keyboards';
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
