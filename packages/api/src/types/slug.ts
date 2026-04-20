/**
 * Known slug prefixes used by the typed slug generator.
 * Must stay in sync with SlugPrefix in apps/api/lib/slug-generator.ts.
 */
export const TYPED_SLUG_PREFIXES = ["PRO", "WRK", "PRD", "PLN", "FEA"] as const;

export const TYPED_SLUG_PATTERN = new RegExp(
  String.raw`^(${TYPED_SLUG_PREFIXES.join("|")})-\d+$`
);

/**
 * Returns true if the slug matches the new typed format (e.g. "PRD-42", "PROJ-1").
 * Old slugs are random nanoid strings and should not be displayed in the UI.
 */
export function isDisplayableSlug(slug: string | null | undefined): boolean {
  if (!slug) {
    return false;
  }
  return TYPED_SLUG_PATTERN.test(slug);
}
