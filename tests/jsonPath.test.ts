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

  it('wildcard * resolves through an opaque-keyed object', () => {
    const r = { cache: { h1: { data: { x: 1 } }, h2: { data: { y: 2 } } } };
    // first value whose remaining path resolves
    expect(resolvePath(r, 'cache.*.data.y')).toBe(2);
    expect(resolvePath(r, 'cache.*.data.x')).toBe(1);
    expect(resolvePath(r, 'cache.*.data.z')).toBeUndefined();
  });

  it('~json decodes a stringified segment and continues', () => {
    const r = { entry: { data: JSON.stringify({ advertSearch: { edges: [{ node: { id: 'a' } }] } }) } };
    expect(resolvePath(r, 'entry.data.~json.advertSearch.edges[0].node.id')).toBe('a');
  });

  it('combines *, ~json and index (AutoVit-style urql path)', () => {
    const data = JSON.stringify({ advertSearch: { edges: [{ node: { id: 'n1' } }] } });
    const r = { urqlState: { ['hash#1']: { hasNext: false, data } } };
    const edges = resolvePath(r, 'urqlState.*.data.~json.advertSearch.edges') as any[];
    expect(edges).toHaveLength(1);
    expect(edges[0].node.id).toBe('n1');
  });

  it('~json on a non-string / * on a non-object return undefined', () => {
    expect(resolvePath({ a: 5 }, 'a.~json.b')).toBeUndefined();
    expect(resolvePath({ a: 5 }, 'a.*.b')).toBeUndefined();
  });
});
