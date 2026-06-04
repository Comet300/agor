import { describe, it, expect } from 'vitest';
import { registrationKeyboard } from '../src/gateway/keyboards';

function labels(kb: ReturnType<typeof registrationKeyboard>): string[] {
  return kb.inline_keyboard.flat().map((b) => ('text' in b ? b.text : ''));
}

describe('registrationKeyboard seller-visibility state', () => {
  it('marks the active seller option with a check', () => {
    const priv = labels(registrationKeyboard(7, 'private'));
    expect(priv).toContain('✅ 👤 Private');
    expect(priv).toContain('🏢 Company'); // others unmarked
    expect(priv).toContain('👥 Both');
  });

  it('defaults to marking "Both"', () => {
    expect(labels(registrationKeyboard(7))).toContain('✅ 👥 Both');
  });

  it('produces a real markup diff between visibilities (avoids Telegram 400 not-modified)', () => {
    const a = JSON.stringify(registrationKeyboard(7, 'private').inline_keyboard);
    const b = JSON.stringify(registrationKeyboard(7, 'company').inline_keyboard);
    expect(a).not.toBe(b);
  });

  it('keeps callback_data stable regardless of the active marker', () => {
    const kb = registrationKeyboard(7, 'company');
    const data = kb.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(data).toContain('sv:7:private');
    expect(data).toContain('sv:7:company');
    expect(data).toContain('sv:7:both');
    expect(data).toContain('go:7');
  });
});
