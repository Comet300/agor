import { describe, it, expect } from 'vitest';
import { resolvePath } from '../src/util/jsonPath';

describe('resolvePath', () => {
  const root = {
    props: { pageProps: { items: [{ id: 'a' }, { id: 'b' }] } },
    photos: [{ link: 'x.jpg' }],
    business: true,
  };
  it('resolves dotted paths', () => {
    expect(resolvePath(root, 'props.pageProps.items')).toHaveLength(2);
  });
  it('resolves bracket indices', () => {
    expect(resolvePath(root, 'photos[0].link')).toBe('x.jpg');
    expect(resolvePath(root, 'props.pageProps.items[1].id')).toBe('b');
  });
  it('returns undefined for missing segments', () => {
    expect(resolvePath(root, 'props.nope.deep')).toBeUndefined();
    expect(resolvePath(root, 'photos[5].link')).toBeUndefined();
  });
  it('returns root for empty path', () => {
    expect(resolvePath(root, '')).toBe(root);
  });
});
