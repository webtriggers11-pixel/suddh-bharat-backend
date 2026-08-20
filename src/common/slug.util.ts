/**
 * Slug helpers (ADR-0010). `slugify` lowercases, strips non-alphanumerics, and
 * hyphenates whitespace. `uniqueSlug` appends -1, -2, … until `exists` returns
 * false, so callers stay storage-agnostic (global vs parent-scoped uniqueness).
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  const root = slugify(base) || 'item';
  if (!(await exists(root))) return root;
  for (let i = 1; ; i++) {
    const candidate = `${root}-${i}`;
    if (!(await exists(candidate))) return candidate;
  }
}
