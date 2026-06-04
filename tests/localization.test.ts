import { describe, it, expect } from 'vitest';
import { messages, tr } from '../src/gateway/strings';
import { resolveLang, DEFAULT_LANG } from '../src/gateway/lang';
import { registrationKeyboard } from '../src/gateway/keyboards';
import { classifyMessage } from '../src/gateway/bot';
import { openStore } from '../src/persistence';
import { ChatPrefsRepo } from '../src/persistence/chatPrefs';
import { openDb } from '../src/persistence/db';

describe('catalog completeness', () => {
  it('ro and en expose exactly the same set of keys', () => {
    expect(Object.keys(messages.ro).sort()).toEqual(Object.keys(messages.en).sort());
  });
});

describe('message routing (classifyMessage)', () => {
  it('routes an http(s) link to a watch', () => {
    expect(classifyMessage('https://www.olx.ro/x')).toBe('url');
  });
  it('routes an unrecognized slash-command to the unknown-command branch', () => {
    // This is what wires tr(lang).unknown_command (the /help hint) instead of
    // the generic link nudge.
    expect(classifyMessage('/foobar')).toBe('command');
  });
  it('routes plain chatter to the generic hint', () => {
    expect(classifyMessage('hello there')).toBe('other');
  });
});

describe('resolveLang resolution order', () => {
  it('a stored preference wins over the Telegram locale', () => {
    expect(resolveLang('en', 'ro')).toBe('en');
    expect(resolveLang('ro', 'en-US')).toBe('ro');
  });

  it('falls back to the Telegram locale when nothing is stored (en* => en)', () => {
    expect(resolveLang(undefined, 'en')).toBe('en');
    expect(resolveLang(undefined, 'en-GB')).toBe('en');
  });

  it('falls back to the ro default otherwise', () => {
    expect(resolveLang(undefined, undefined)).toBe(DEFAULT_LANG);
    expect(resolveLang(undefined, 'fr')).toBe('ro');
    expect(resolveLang('xx', 'fr')).toBe('ro'); // invalid stored value ignored
    expect(DEFAULT_LANG).toBe('ro');
  });
});

describe('ChatPrefsRepo round-trip', () => {
  it('set then get returns the stored language', () => {
    const repo = new ChatPrefsRepo(openDb(':memory:'));
    repo.setLang(42, 'en');
    expect(repo.getLang(42)).toBe('en');
    // Upsert: a second set overwrites.
    repo.setLang(42, 'ro');
    expect(repo.getLang(42)).toBe('ro');
  });

  it('returns undefined for a chat that never set a language', () => {
    const repo = new ChatPrefsRepo(openDb(':memory:'));
    expect(repo.getLang(99)).toBeUndefined();
  });

  it('is wired onto the Store', () => {
    const store = openStore(':memory:');
    store.chatPrefs.setLang(1, 'en');
    expect(store.chatPrefs.getLang(1)).toBe('en');
    expect(store.chatPrefs.getLang(2)).toBeUndefined();
  });
});

describe('registrationKeyboard localized labels vs stable data', () => {
  const flat = (kb: ReturnType<typeof registrationKeyboard>) => kb.inline_keyboard.flat();
  const labels = (kb: ReturnType<typeof registrationKeyboard>) =>
    flat(kb).map((b) => ('text' in b ? b.text : ''));
  const data = (kb: ReturnType<typeof registrationKeyboard>) =>
    flat(kb).map((b) => ('callback_data' in b ? b.callback_data : ''));

  it('marks the active seller visibility and frequency preset', () => {
    const lbls = labels(registrationKeyboard(3, 'en', 'company', 60));
    expect(lbls).toContain(`✅ ${tr('en').btn_company}`);
    expect(lbls).toContain(`✅ ${tr('en').btn_freq(60)}`);
  });

  it('includes rm:, fq: and go: callback data', () => {
    const d = data(registrationKeyboard(3, 'en'));
    expect(d).toContain('rm:3');
    expect(d).toContain('fq:3:5');
    expect(d).toContain('go:3');
  });

  it('RO vs EN labels differ while callback data is identical', () => {
    const en = registrationKeyboard(3, 'en', 'private', 10);
    const ro = registrationKeyboard(3, 'ro', 'private', 10);
    expect(labels(en)).not.toEqual(labels(ro));
    expect(data(en)).toEqual(data(ro));
  });
});
