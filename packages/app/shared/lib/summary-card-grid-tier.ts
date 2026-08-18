import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";

/**
 * The `md+` tier a `SummaryCardRow` lays out its auto-fit grid in, and the
 * boundary BELOW which the row's own static `grid-cols-2` class governs instead
 * (FEA-3865's phone pairing).
 *
 * Keyed off the same 768px `CARD_FALLBACK_BREAKPOINT` the `md:` utilities and
 * `GridTable`'s card fallback use, so the strip and the table beneath it migrate
 * at one width rather than two.
 *
 * Two hooks need this answer and they must never disagree about it:
 * `useSummaryCardColumns` (which stands DOWN below `md`, where its inline
 * template would override the row's class) and `useSummaryCardDensity` (which
 * asks a DIFFERENT question below `md`, because the rank size is fixed there —
 * see its resolver). It used to be declared privately inside the columns hook;
 * ISS-5366 gave the density hook the same dependency, so it moved here rather
 * than being copied, and rather than making the density hook import from the
 * columns hook for a media query neither owns.
 */
export const GRID_TIER_MEDIA_QUERY = `(min-width: ${CARD_FALLBACK_BREAKPOINT}px)`;

/**
 * The `md+` media query, or `null` where `matchMedia` is unavailable (the
 * server, a bare jsdom environment).
 */
export function gridTierQuery(): MediaQueryList | null {
  if (globalThis.window === undefined || !globalThis.window.matchMedia) {
    return null;
  }
  return globalThis.window.matchMedia(GRID_TIER_MEDIA_QUERY);
}

/**
 * Whether the viewport is in the `md+` tier.
 *
 * `matchMedia` is absent in a bare jsdom environment and on the server; both
 * answer TRUE so the callers still run in the strip's own render tests and in
 * any renderer that lacks it, rather than silently switching to the phone
 * regime on a desktop. The `md:` utility tiers are viewport media queries, so
 * the viewport — not the row's measured width — is what decides which tier's
 * CSS is live.
 */
export function matchesGridTier(): boolean {
  const query = gridTierQuery();
  return query === null || query.matches;
}
