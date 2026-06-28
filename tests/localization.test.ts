import { describe, it, expect } from 'vitest';
import { messages, tr, commandMenu, LANGS } from '../src/gateway/strings';
import { resolveLang, DEFAULT_LANG } from '../src/gateway/lang';
import { registrationKeyboard } from '../src/gateway/keyboards';
import { classifyMessage } from '../src/gateway/bot';
import { openStore } from '../src/persistence';
import { ChatPrefsRepo } from '../src/persistence/chatPrefs';
import { openDb } from '../src/persistence/db';

describe('catalog completeness', () => {
  it('every language exposes exactly the same set of keys as Romanian', () => {
    const roKeys = Object.keys(messages.ro).sort();
    for (const lang of LANGS) {
      expect(Object.keys(messages[lang]).sort()).toEqual(roKeys);
    }
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

describe('resolveLang (Romanian-first)', () => {
  it('a stored preference wins', () => {
    expect(resolveLang('en')).toBe('en');
    expect(resolveLang('ro')).toBe('ro');
  });

  it('defaults to Romanian when nothing is stored', () => {
    expect(resolveLang(undefined)).toBe('ro');
    expect(resolveLang(undefined)).toBe(DEFAULT_LANG);
    expect(DEFAULT_LANG).toBe('ro');
  });

  it('ignores an invalid stored value and falls back to Romanian', () => {
    expect(resolveLang('xx')).toBe('ro');
  });
});

describe('command menu', () => {
  it('every language exposes the same command set, each with a description', () => {
    const roCmds = commandMenu.ro.map((c) => c.command).sort();
    for (const lang of LANGS) {
      expect(commandMenu[lang].map((c) => c.command).sort()).toEqual(roCmds);
      for (const c of commandMenu[lang]) {
        expect(c.description.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('list_item exclusions', () => {
  const base = { id: 3, vendor: 'OLX', type: 'search', seller: 'both', url: 'https://x', tracked: false, paused: false, required: '', blocked: 0 };
  it('appends exclusion keywords when present', () => {
    expect(tr('ro').list_item({ ...base, exclusions: 'lovit, dube' })).toContain('excluse: lovit, dube');
    expect(tr('en').list_item({ ...base, exclusions: 'damaged' })).toContain('excluded: damaged');
  });
  it('omits the segment when there are no exclusions', () => {
    expect(tr('ro').list_item({ ...base, exclusions: '' })).not.toContain('excluse');
  });
  it('shows a 📌 badge only for a tracked watch', () => {
    expect(tr('en').list_item({ ...base, exclusions: '', tracked: true })).toContain('📌');
    expect(tr('en').list_item({ ...base, exclusions: '' })).not.toContain('📌');
  });
  it('omits seller + exclusions for a product watch (no result set to filter)', () => {
    const product = { ...base, type: 'product', tracked: true, exclusions: 'ignored' };
    const en = tr('en').list_item(product);
    expect(en).not.toContain('seller=');
    expect(en).not.toContain('excluded:');
    expect(en).toContain('📌');     // still badged as tracked
    expect(en).toContain('product'); // type still shown
    expect(tr('ro').list_item(product)).not.toContain('vânzător=');
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

  it('marks the active seller and shows the current interval', () => {
    const lbls = labels(registrationKeyboard(3, 'en', 'company', 60));
    expect(lbls).toContain(`✅ ${tr('en').btn_company}`);
    expect(lbls).toContain(tr('en').btn_interval('1h'));
  });

  it('includes rm:, fqi: and go: callback data', () => {
    const d = data(registrationKeyboard(3, 'en'));
    expect(d).toContain('rm:3');
    expect(d).toContain('fqi:3'); // interval button (presets are behind it)
    expect(d).toContain('go:3');
  });

  it('RO vs EN labels differ while callback data is identical', () => {
    const en = registrationKeyboard(3, 'en', 'private', 10);
    const ro = registrationKeyboard(3, 'ro', 'private', 10);
    expect(labels(en)).not.toEqual(labels(ro));
    expect(data(en)).toEqual(data(ro));
  });
});
