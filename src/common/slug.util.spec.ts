import { RESERVED_SLUGS, slugify, uniqueSlug } from './slug.util';

describe('slugify', () => {
  it('lowercases, strips punctuation, and hyphenates', () => {
    expect(slugify('  Stone-Ground Whole Wheat Atta (5kg) ')).toBe(
      'stone-ground-whole-wheat-atta-5kg',
    );
  });

  it('falls back through uniqueSlug when nothing survives', async () => {
    expect(slugify('!!!')).toBe('');
    expect(await uniqueSlug('!!!', () => Promise.resolve(false))).toBe('item');
  });
});

describe('uniqueSlug', () => {
  it('returns the root when it is free', async () => {
    expect(await uniqueSlug('Atta', () => Promise.resolve(false))).toBe('atta');
  });

  it('suffixes until a free slug is found', async () => {
    const taken = new Set(['atta', 'atta-1']);
    expect(await uniqueSlug('Atta', (s) => Promise.resolve(taken.has(s)))).toBe(
      'atta-2',
    );
  });

  /**
   * `/products/admin/*` is the admin sub-tree. A product slugged `admin` would
   * make `/products/admin/related` hit the role-guarded handler and 401 every
   * shopper, so a reserved word is treated as taken.
   */
  it('never issues a slug that collides with a route segment', async () => {
    expect(await uniqueSlug('Admin', () => Promise.resolve(false))).toBe(
      'admin-1',
    );
    for (const reserved of RESERVED_SLUGS) {
      expect(await uniqueSlug(reserved, () => Promise.resolve(false))).not.toBe(
        reserved,
      );
    }
  });
});
