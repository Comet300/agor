/**
 * splitForTelegram (T2-7): /list and long exclusion replies must not exceed
 * Telegram's 4096-char limit (which would surface as an opaque generic_error).
 * The splitter chunks within the limit, preferring paragraph boundaries.
 */
import { describe, it, expect } from 'vitest';
import { splitForTelegram } from '../src/gateway/bot';

describe('splitForTelegram', () => {
  it('returns the text unchanged when it fits', () => {
    expect(splitForTelegram('short', 4096)).toEqual(['short']);
  });

  it('splits an oversized message into chunks each within the limit', () => {
    // 30 paragraphs of 200 chars each, joined by blank lines → ~6000 chars.
    const paras = Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(200, 'x'));
    const text = paras.join('\n\n');
    const chunks = splitForTelegram(text, 4096);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    // No data lost: rejoining reproduces the original.
    expect(chunks.join('\n\n')).toBe(text);
  });

  it('prefers paragraph boundaries (does not split mid-paragraph when avoidable)', () => {
    const a = 'A'.repeat(2500);
    const b = 'B'.repeat(2500);
    const chunks = splitForTelegram(`${a}\n\n${b}`, 4096);
    expect(chunks).toEqual([a, b]); // each paragraph kept whole in its own chunk
  });

  it('hard-splits a single paragraph that alone exceeds the limit', () => {
    const huge = 'Z'.repeat(9000);
    const chunks = splitForTelegram(huge, 4096);
    expect(chunks.length).toBe(3); // 4096 + 4096 + 808
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    expect(chunks.join('')).toBe(huge);
  });
});
