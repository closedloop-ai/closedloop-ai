/**
 * The `Card` density variant (ISS-5070).
 *
 * ## Why this file exists
 *
 * ISS-5068 shipped the dense Sessions summary strip as six descendant overrides
 * written inline on `SummaryCardRow` — a selector patch that reached into three
 * slots of a primitive it does not own, with nothing linking the values it wrote
 * to the primitive's own. The day `Card` goes `px-6` → `px-5`, that string still
 * said `px-4` against a different baseline and no test noticed, because the
 * tests asserted the class string rather than the RELATIONSHIP.
 *
 * So the density is expressed once, here, beside the `Card` primitive whose
 * values it steps down from: {@link CARD_COMFORTABLE_SLOT_UTILITIES} names what
 * `card.tsx` ships, {@link CARD_COMPACT_SLOT_UTILITIES} names the step-down, and
 * `__tests__/card-density.test.tsx` asserts the comfortable column against the
 * REAL primitive's rendered classes — so moving `Card`'s padding fails a test
 * here instead of silently desynchronising a string in another package.
 *
 * ## Why it is NOT inside `Card` itself
 *
 * Deliberately (ISS-5068, re-verified by the ISS-5070 review). Charging the
 * density inside the primitive reflows every consumer, and the Insights KPI
 * tiles sit on a FIXED 156px grid host: a height change inside the card pushes
 * their trend footer into the grid gutter (`metric-card.tsx`). `Card` therefore
 * stays byte-identical and the density is opted into by the HOST that lays cards
 * out in a rank.
 *
 * ## How a host opts in
 *
 * The host applies {@link CARD_DENSITY_VARIANT_CLASS} unconditionally and sets
 * `data-density` (see {@link CARD_DENSITY_ATTRIBUTE}) to the tier it wants. The
 * rules below are self-gated on `[data-density=compact]`, so the class is inert
 * at comfortable density and the switch is ONE attribute rather than a
 * conditionally-concatenated string. `packages/design-system` cannot read a
 * feature flag; the host decides, this file only describes the two densities.
 */

/**
 * The attribute a host sets to choose a density for the cards beneath it. Its
 * value is a {@link CardDensity}.
 */
export const CARD_DENSITY_ATTRIBUTE = "data-density";

export const CardDensity = {
  /** What `Card` ships: `py-6` / `gap-6` / `px-6`. */
  Comfortable: "comfortable",
  /** The stepped-down interior a rank of summary tiles lays out against. */
  Compact: "compact",
} as const;

export type CardDensity = (typeof CardDensity)[keyof typeof CardDensity];

/**
 * The utilities `card.tsx` ITSELF ships on each slot — the baseline the compact
 * column below steps down from.
 *
 * This is not documentation: `card-density.test.tsx` renders the real `Card`
 * family and asserts every value here is on the matching slot. It is the link
 * ISS-5070 asked for, so the two densities are one decision in one file rather
 * than a string in another package that quietly stops describing anything.
 */
export const CARD_COMFORTABLE_SLOT_UTILITIES = {
  cardGap: "gap-6",
  cardPaddingY: "py-6",
  headerPaddingX: "px-6",
  contentPaddingX: "px-6",
  footerPaddingX: "px-6",
} as const;

/**
 * The compact step-down, per slot.
 *
 * PADDING. `px-6` → `px-4` returns 16px of interior at any card width, which is
 * what lets a rank of tiles lay out against a lower per-card floor instead of a
 * naive shrink that would push a long label onto a third line (ISS-4787).
 *
 * GAP. `gap-6` → `gap-3`, NOT `gap-4`, is arithmetic rather than taste:
 * `MetricCard` puts a fixed `pb-3` on its header, so the value/caption seam is
 * `pb-3 + gap`, never the gap alone. Comfortable that seam is `12 + 24 = 36`
 * against 24px of outer padding, a ratio of 1.5; `12 + 12 = 24` against 16px
 * keeps it. `gap-4` would give 1.75 and read airier inside the card than
 * outside. Do not "fix the inconsistency" between `py-4` and `gap-3` by
 * aligning them — the header's `pb-3` is why they differ.
 *
 * CAPTION RESERVATION (`contentMinHeight`). A card's detail caption is an
 * unclamped wrapping span with no floor of its own, so at the compact floor's
 * narrower content box a composed caption can take a second line where it took
 * one at the comfortable width — making the card's HEIGHT depend on its content,
 * which no single skeleton constant can describe. `min-h-10` reserves exactly
 * two `text-sm` lines (2 × 1.25rem), the same move ISS-4787 made for the label
 * region one line up. It is a FLOOR, not a clamp: a caption needing a third line
 * still gets it, and that card then sets its rank's height rather than being
 * clipped.
 */
export const CARD_COMPACT_SLOT_UTILITIES = {
  cardGap: "gap-3",
  cardPaddingY: "py-4",
  headerPaddingX: "px-4",
  contentPaddingX: "px-4",
  footerPaddingX: "px-4",
  contentMinHeight: "min-h-10",
  /** The bordered-header / bordered-footer separators `Card` sets to 6. */
  borderedSeamPadding: "4",
} as const;

/**
 * The density variant itself: apply on the host, switch with
 * {@link CARD_DENSITY_ATTRIBUTE}.
 *
 * Every rule is written as a literal because Tailwind extracts candidates from
 * SOURCE TEXT — a runtime-composed class name is never generated. The constants
 * above are therefore the reviewable record and the test's anchor, not the
 * string's inputs.
 *
 * ISS-5070 item 1a: `CardFooter`'s `px-6` and the bordered-seam paddings on
 * `CardHeader`/`CardFooter` ARE covered here, where the inline patch this
 * replaces covered neither. `MetricCard` renders no footer today so nothing was
 * broken — but a rank accepts arbitrary children, and a card with a footer among
 * compact siblings would have rendered 24px gutters beside 16px ones. The
 * bordered-seam rules name the slot AND the border class in one compound
 * selector (`.border-b[data-slot=card-header]`), which is the bordered-header
 * case `Card`'s own rule is written for, and outranks it on specificity wherever
 * both apply.
 */
export const CARD_DENSITY_VARIANT_CLASS =
  "[&[data-density=compact]_[data-slot=card]]:gap-3 [&[data-density=compact]_[data-slot=card]]:py-4 [&[data-density=compact]_[data-slot=card-header]]:px-4 [&[data-density=compact]_[data-slot=card-content]]:px-4 [&[data-density=compact]_[data-slot=card-content]]:min-h-10 [&[data-density=compact]_[data-slot=card-footer]]:px-4 [&[data-density=compact]_.border-b[data-slot=card-header]]:pb-4 [&[data-density=compact]_.border-t[data-slot=card-footer]]:pt-4";
