import { describe, it, expect } from 'vitest';
import { toCsv } from '../src/util/csv';

describe('toCsv', () => {
  it('writes a header row then one row per record', () => {
    const csv = toCsv(['a', 'b'], [{ a: 1, b: 2 }, { a: 3, b: 4 }]);
    expect(csv).toBe('a,b\r\n1,2\r\n3,4');
  });

  it('quotes fields containing comma, quote or newline and doubles quotes', () => {
    const csv = toCsv(['t'], [{ t: 'a,b' }, { t: 'say "hi"' }, { t: 'two\nlines' }]);
    expect(csv).toBe('t\r\n"a,b"\r\n"say ""hi"""\r\n"two\nlines"');
  });

  it('renders missing/undefined cells as empty', () => {
    expect(toCsv(['a', 'b'], [{ a: 'x' }])).toBe('a,b\r\nx,');
  });
});
