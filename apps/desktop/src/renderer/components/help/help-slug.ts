/**
 * GitHub-style heading slug, kept byte-for-byte in step with the bundle
 * generator's `slugify` (`scripts/generate-docs-bundle-manifest-lib.mjs`) so a
 * search hit's `headingSlug` matches the `id` the Help reader stamps on the
 * rendered heading — that shared contract is what makes search-jump-to-heading
 * land on the right anchor. Kept as its own tiny module so both the reader and
 * its tests import the one implementation.
 */
const SLUG_STRIP_RE = /[^a-z0-9\s-]/g;
const SLUG_SPACE_RE = /\s+/g;

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(SLUG_STRIP_RE, "")
    .trim()
    .replace(SLUG_SPACE_RE, "-");
}
