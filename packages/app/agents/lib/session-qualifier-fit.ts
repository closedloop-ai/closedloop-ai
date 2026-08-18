/**
 * How many chips fit the width a flexible chip column actually got.
 *
 * ISS-5282 wrote this for the `Signals` column; ISS-5770 removed that column and
 * the arithmetic outlived it, because the problem was never specific to row
 * qualifiers. Its consumers now are the linked-entity columns — `Owning project`
 * and `Linked issues` (`SessionLinkedChipsCell`) — plus the track-floor
 * derivation in `sessions-table-columns.ts`, which sizes those tracks from the
 * same measurement the cell fits against so a declared floor cannot promise room
 * the cell does not have.
 *
 * The columns ship as `minmax(<floor>, 0.5fr)`, so rendered width is not a
 * constant: at the narrowest supported surface it is the floor, and on a wide
 * window it takes a share of the surplus. A FIXED visible cap against a variable
 * track is the bug the original review named — with the cap pinned at one, a
 * 1440px window rendered one chip and a counter somebody had to click while
 * several hundred spare pixels sat unused, making overflow the normal case
 * rather than the crowded one.
 *
 * Pure arithmetic over label lengths so it is unit-testable without a DOM, and so
 * the count a cell renders and the count its overflow counter claims come from
 * one place.
 */

/**
 * Approximate rendered width (px) of one qualifier chip.
 *
 * A `ToneBadge` is `text-[11px]` semibold inside `px-2.5` with a `gap-1.5` and a
 * state dot. The character estimate is deliberately GENEROUS (11px semibold in
 * the product's UI face averages nearer 6px per character): overestimating a
 * chip drops one from the visible set and discloses it in the counter, while
 * underestimating renders a chip the track cannot hold, which is the crowding
 * this whole cell exists to avoid. Rounding errors are therefore spent on the
 * safe side on purpose.
 */
const QUALIFIER_CHIP_CHAR_WIDTH_PX = 6.5;

/** Chip chrome: horizontal padding, the state dot, and its gap. */
const QUALIFIER_CHIP_CHROME_PX = 34;

/** The `gap-1` between two chips on the cell's single line. */
const QUALIFIER_CHIP_GAP_PX = 4;

/**
 * Width reserved for the `+N` counter whenever anything overflows. A two-digit
 * counter is the realistic worst case for a vocabulary this size.
 */
const QUALIFIER_OVERFLOW_CHIP_WIDTH_PX = 44;

/**
 * How many of `labels` render before the rest collapse into `+N`, given the
 * cell's measured content width.
 *
 * Always at least one: a cell too narrow for even the leading chip still shows
 * it rather than collapsing everything behind a counter and leaving the row with
 * no visible state at all. `useSessionRowQualifiers` orders `Awaiting input`
 * first precisely so that the guaranteed-visible slot holds the most actionable
 * state.
 *
 * ISS-5666: that floor RETURNS A COUNT THIS FUNCTION COULD NOT BUDGET FOR — when
 * the leading chip alone busts the width, the caller still appends a `+N` the
 * arithmetic never reserved room for. Honouring the floor is therefore only half
 * the contract; `SessionQualifiersCell` owns the other half, giving the visible
 * chips a shrinkable track so the counter keeps its width and stays clickable
 * instead of being clipped out of the cell. Do not "fix" the overflow by
 * removing this floor — a row with every chip behind a counter is the state this
 * floor exists to prevent.
 *
 * A non-finite or non-positive width means "not measured yet" (SSR, a detached
 * or `display:none` container, the first paint before the observer reports) and
 * falls back to that same single chip, so the unmeasured frame never promises
 * more chips than the track can hold and then reflows.
 */
export function resolveVisibleQualifierCount(
  labels: readonly string[],
  availableWidthPx: number,
  geometry: ChipFitGeometry = TONE_BADGE_FIT_GEOMETRY
): number {
  if (labels.length <= 1) {
    return labels.length;
  }
  if (!(Number.isFinite(availableWidthPx) && availableWidthPx > 0)) {
    return 1;
  }
  let usedPx = 0;
  for (const [index, label] of labels.entries()) {
    const chipPx =
      estimateQualifierChipWidthPx(label, geometry) +
      (index === 0 ? 0 : QUALIFIER_CHIP_GAP_PX);
    // Every chip but the last has to leave room for the counter that will
    // disclose whatever it pushed out.
    const isLast = index === labels.length - 1;
    const reservePx = isLast
      ? 0
      : QUALIFIER_CHIP_GAP_PX + QUALIFIER_OVERFLOW_CHIP_WIDTH_PX;
    if (usedPx + chipPx + reservePx > availableWidthPx) {
      return Math.max(1, index);
    }
    usedPx += chipPx;
  }
  return labels.length;
}

/** Approximate rendered width (px) of one chip carrying `label`. */
export function estimateQualifierChipWidthPx(
  label: string,
  geometry: ChipFitGeometry = TONE_BADGE_FIT_GEOMETRY
): number {
  return label.length * geometry.charWidthPx + geometry.chromePx;
}

/**
 * The per-chip geometry the fit measures against.
 *
 * Parameterised (FEA-4209 / FEA-4210) because the fit is now shared by two cells
 * whose pills are DIFFERENT primitives, and the constants above describe only the
 * first one. Getting this wrong is not cosmetic: the module's whole safety
 * argument is that it overestimates, so an underestimate renders a chip the track
 * cannot hold and it clips silently against the cell's `overflow-hidden`.
 */
export type ChipFitGeometry = Readonly<{
  /** Approximate px per character at the pill's type size. */
  charWidthPx: number;
  /** Non-text px per pill: horizontal padding, any leading glyph, and its gap. */
  chromePx: number;
}>;

/**
 * `ToneBadge` — the `Signals` column's pill, and this module's original subject:
 * `text-[11px]` semibold in `px-2.5` with a `gap-1.5` and a state dot.
 */
export const TONE_BADGE_FIT_GEOMETRY: ChipFitGeometry = {
  charWidthPx: QUALIFIER_CHIP_CHAR_WIDTH_PX,
  chromePx: QUALIFIER_CHIP_CHROME_PX,
};

/**
 * The design-system `Chip` at its DEFAULT size — the linked-entity columns' pill:
 * `h-6 px-2.5 text-xs` with a `gap-1` and a `size-3.5` leading icon. Chrome is
 * `20 (px-2.5) + 14 (icon) + 4 (gap) = 38`, and `text-xs` is 12px rather than
 * ToneBadge's 11px, so BOTH terms are larger. Reusing the ToneBadge numbers here
 * under-measured every chip by ~4px, which is the unsafe direction.
 */
export const DS_CHIP_FIT_GEOMETRY: ChipFitGeometry = {
  charWidthPx: 7,
  chromePx: 38,
};

/**
 * Content-box width (px) a cell needs to show `label`'s chip AND the `+N`
 * counter that discloses whatever it pushed out — the narrowest state in which
 * a multi-chip cell is still fully navigable.
 *
 * Exported so a COLUMN can derive its track floor from the same arithmetic the
 * fit uses at render time, instead of a hand-computed constant that silently
 * stops being true when either number moves (FEA-4209 / FEA-4210: the first
 * draft of the linked-entity floor was wrong by 30px in exactly that way).
 */
export function estimateChipPlusOverflowWidthPx(
  label: string,
  geometry: ChipFitGeometry = TONE_BADGE_FIT_GEOMETRY
): number {
  return (
    estimateQualifierChipWidthPx(label, geometry) +
    QUALIFIER_CHIP_GAP_PX +
    QUALIFIER_OVERFLOW_CHIP_WIDTH_PX
  );
}

/**
 * The width a measured cell passes when it has no real measurement yet (SSR,
 * first paint before the observer reports, a detached or `display:none`
 * container). Zero is not a width, and {@link resolveVisibleQualifierCount}
 * reads it as "unmeasured" and falls back to a single chip — so the unmeasured
 * frame never promises more chips than the track holds and then reflows.
 *
 * Exported so the cells that share this fit share the sentinel too, rather than
 * each re-declaring it.
 */
export const UNMEASURED_CHIP_CELL_WIDTH_PX = 0;

/**
 * Accessible name for a `+N` overflow counter.
 *
 * `+2` announced alone is not a fact anybody can act on, and the popover that
 * names the hidden entries is behind an activation a screen-reader user has to
 * choose to make — so the button's own name carries the same list the panel
 * does. Customer-facing text, so a plain comma-joined list and no em dash
 * (#3449).
 *
 * `noun` is optional: the `Signals` column's qualifiers have no natural noun and
 * keep the original "N more: …" wording, while a column of one entity kind names
 * it ("2 more issues: …").
 */
export function chipOverflowAriaLabel(
  labels: readonly string[],
  noun?: string
): string {
  if (!noun) {
    return `${labels.length} more: ${labels.join(", ")}`;
  }
  const plural = labels.length === 1 ? noun : `${noun}s`;
  return `${labels.length} more ${plural}: ${labels.join(", ")}`;
}
