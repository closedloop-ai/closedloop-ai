/**
 * Normalize a CatalogItem name to a pack_id matching the local catalog.
 * Lowercases and replaces non-alphanumeric runs with hyphens, matching the
 * convention used in catalog-seed.json (e.g. "RTK" → "rtk", "GStack" → "gstack").
 *
 * Single source of truth shared by the main-process auto-installer
 * (`required-plugin-installer.ts`) and the renderer opt-in banner
 * (`opt-in-distributions-banner.tsx`) so the renderer accept action and the
 * headless auto-install resolve the identical local pack id.
 */
export function normalizePackId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}
