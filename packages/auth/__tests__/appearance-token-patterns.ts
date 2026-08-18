// Shared token-contract patterns + helpers for the Clerk appearance tests
// (`appearance.test.ts`, `embedded-profile-appearance.test.ts`). The Parker
// design-system line forbids hard-coded hex colors and raw pixel values in the
// appearance configs — every value must resolve to a design-system CSS custom
// property. These patterns are the single source of truth for that check so the
// two appearance suites cannot drift.

// Matches any 3/4/6/8-digit hex color literal (e.g. `#fff`, `#0a0a0aff`).
export const HEX_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b/;
// Matches a raw pixel value (e.g. `12px`). A `1px solid var(--border)` border
// shorthand is the one intentional exception the embedded config relies on, so
// callers that forbid raw pixels should whitelist that border idiom explicitly.
export const RAW_PIXEL_PATTERN = /\b\d+px\b/;

/**
 * Recursively collects every string value reachable in a Clerk `elements` map,
 * including strings nested inside object-valued rules (e.g.
 * `{ background: "var(--primary)" }`) and inside their pseudo-selector blocks
 * (`{ "&:hover": { background: "..." } }`). Clerk appearance rules may be either
 * a utility-class string or a style object, so a token-only assertion must walk
 * both shapes — a `backgroundColor: "#fff"` buried in an object must not slip
 * past a check that only reads top-level strings.
 */
export function collectAppearanceStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectAppearanceStrings);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectAppearanceStrings);
  }
  return [];
}
