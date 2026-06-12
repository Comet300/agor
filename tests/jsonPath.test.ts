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

  it('wildcard * iterates ARRAY elements (ld+json @graph)', () => {
    const r = { '@graph': [{ a: 1 }, { mainEntity: { items: [7] } }] };
    expect(resolvePath(r, '@graph.*.mainEntity.items')).toEqual([7]);
  });

  it('~tail:<sep> takes the substring after the last separator', () => {
    const r = { item: { '@id': 'https://x/#/schema/Product/item-273353106' } };
    expect(resolvePath(r, 'item.@id.~tail:-')).toBe('273353106');
    expect(resolvePath(r, 'item.@id.~tail:/')).toBe('item-273353106');
    expect(resolvePath({ n: 5 }, 'n.~tail:-')).toBeUndefined(); // strings only
  });

  it('~json on a non-string / * on a non-object return undefined', () => {
    expect(resolvePath({ a: 5 }, 'a.~json.b')).toBeUndefined();
    expect(resolvePath({ a: 5 }, 'a.*.b')).toBeUndefined();
  });

  it('~type:<T> selects the first @graph array element of that @type', () => {
    const graph = {
      '@graph': [
        { '@type': 'Organization', name: 'Acme' },
        { '@type': 'Product', name: 'Apartment', '@id': 'https://x/Product/item-99' },
        { '@type': 'Offer', priceSpecification: { price: 185000, priceCurrency: 'EUR' } },
      ],
    };
    expect(resolvePath(graph, '@graph.~type:Product.name')).toBe('Apartment');
    expect(resolvePath(graph, '@graph.~type:Offer.priceSpecification.price')).toBe(185000);
    expect(resolvePath(graph, '@graph.~type:Offer.priceSpecification.priceCurrency')).toBe('EUR');
    expect(resolvePath(graph, '@graph.~type:Product.@id.~tail:-')).toBe('99');
    // No node of that type → undefined (item then drops on a required field).
    expect(resolvePath(graph, '@graph.~type:RealEstateListing.name')).toBeUndefined();
  });

  it('~type:<T> on a non-array or with no match returns undefined', () => {
    expect(resolvePath({ x: 1 }, 'x.~type:Product')).toBeUndefined();
    expect(resolvePath({ '@graph': [{ '@type': 'A' }] }, '@graph.~type:B.name')).toBeUndefined();
  });
});
