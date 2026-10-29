/**
 * Leading-column pinning for the `GridTable` primitive (ISS-6959).
 *
 * A `GridTable` renders no scroll container of its own — the host owns it — and
 * its rows are `min-w-fit`, so a table whose tracks exceed the viewport scrolls
 * horizontally inside that host. Scrolling a right-hand column into view
 * therefore carries the leading IDENTITY track off-screen with everything else,
 * and a row that read "feat/pin-name — Marisol — 3 — Open" degrades to
 * "— 3 — Open": the reader can see the values but no longer which record they
 * belong to.
 *
 * Pinning removes that by taking the identity cell out of the horizontal scroll
 * with `position: sticky; left: 0`. Nothing is hidden, narrowed, or reordered:
 * every track keeps its declared width and its place in the scroll order, and at
 * `scrollLeft: 0` the table is laid out exactly as it is unpinned.
 *
 * ## Why the pinned cell paints its own surface
 *
 * A sticky cell stops moving while its ROW keeps moving underneath it, so
 * whatever the row is painting — a chip, a branch name, a timestamp — slides
 * beneath the pinned cell and shows through unless that cell is opaque. The row
 * background alone is not enough: it belongs to the row and scrolls with it.
 *
 * The row's hover and selected treatments are ALPHA tints
 * (`bg-muted/40`, `bg-primary/10`), which is exactly what an opaque pinned cell
 * cannot use as its own background — a 40%-opaque cell is a window onto the
 * columns passing behind it. So the pinned cell paints the OPAQUE surface token
 * as its background and restates the tint on a `::before` overlay above it,
 * which stays fully opaque. That composite matches the rest of the row exactly
 * while `--grid-table-surface` is ALSO what sits behind the row — the row's
 * tints replace its background rather than layering on it, so a table that
 * points the var at something other than its own container's surface would read
 * a shade apart at the pin. The overlay sits at a negative z-index inside the stacking
 * context the pinned cell's own `z-index` creates, so it paints above that
 * opaque background and below the cell's content — the branch name is tinted
 * with the row, never washed out by it.
 */

/**
 * Everything a pinned cell needs EXCEPT its horizontal anchor, so the identity
 * cell's two anchors — `left-0` at the edge, or the declared utility track's
 * width behind a utility cell — cannot drift apart in surface, stretch, or
 * stacking tier. The `left-0` case is written as a whole literal below because
 * Tailwind scans source text; the offset case cannot be a class at all (see
 * {@link PINNED_LEAD_AFTER_UTILITY_CELL_CLASS}).
 */
const PINNED_CELL_BASE_CLASS =
  "sticky z-[var(--z-pinned-column)] h-full bg-[var(--grid-table-surface,var(--background))]";

/**
 * The pinned leading cell itself: out of the horizontal scroll, above the
 * sibling cells that pass beneath it, and opaque so they cannot show through.
 *
 * `h-full` is load-bearing, not cosmetic. The body row is `grid h-11
 * items-center`, and `align-items: center` sizes a grid item to its CONTENT —
 * so a single-line lead cell is ~28px tall in a 44px row. Unstretched, the
 * opaque surface below covers only those 28px and the columns scrolling behind
 * show through an 8px band above and below every row, which is the exact defect
 * this module exists to prevent. Every sibling cell already compensates
 * (`GridTableCell` and the leading-utility cell both carry `h-full`); the lead
 * cell is the one that did not, because until it was pinned it painted nothing.
 *
 * `z-[var(--z-pinned-column)]` is deliberately the LOWEST non-base tier. The
 * header row sits at `--z-sticky`, so a pinned body cell must stay under it or a
 * scrolled row would paint over the column labels; this tier beats the row's
 * other (unpositioned) cells and nothing else. It also creates the stacking
 * context {@link PINNED_LEAD_TINT_CLASS} relies on.
 */
export const PINNED_LEAD_CELL_CLASS = `${PINNED_CELL_BASE_CLASS} left-0`;

/**
 * The identity cell when a leading UTILITY track (favourite star, checkbox)
 * sits to its left and is itself pinned at `left: 0` (ISS-9223).
 *
 * Offsetting rather than skipping the pin is what lets a list keep BOTH:
 * unpinned, the utility cell scrolls away and leaves a window onto the columns
 * passing behind the identity cell; pinned at `left: 0` without an offset, the
 * identity cell parks on top of it.
 *
 * This class carries NO `left-*` anchor. `gridTemplateColumns` is arbitrary —
 * the primitive never declares the utility track, the CALLER does — so a fixed
 * `left-9` would be correct only for the 36px track today's callers happen to
 * declare, and a consumer with a 52px one would get its two pinned cells
 * overlapping. The anchor is derived from that same declared track by
 * {@link resolveLeadingUtilityPinOffset} and applied as an inline `left`, which
 * is also the only form a statically-scanned class system can express: an
 * interpolated `left-${n}` generates nothing.
 */
export const PINNED_LEAD_AFTER_UTILITY_CELL_CLASS = PINNED_CELL_BASE_CLASS;

/**
 * The leading utility cell itself, once the pin extends over it. Same surface
 * and stacking tier as the identity cell — it is the left half of one pinned
 * region, not a second thing — and it takes the tint overlay for the same
 * reason: it stops moving while its row keeps moving underneath it.
 */
export const PINNED_LEAD_UTILITY_CELL_CLASS = PINNED_LEAD_CELL_CLASS;

/**
 * Inside the sticky header row, covered columns can carry z-20 resize handles.
 * The pinned-header tier keeps both halves above those handles;
 * the sticky header row's own stacking context still stays at z-10.
 * The web and Desktop overlap E2E cases check this relation at the covered
 * handle edge.
 */
export const PINNED_HEADER_STACKING_CLASS = "z-[var(--z-pinned-header)]";

/**
 * The width `GridTableV2` offers callers for a leading utility track, re-exported
 * there as `GRID_TABLE_V2_FAVORITE_TRACK` and what every caller in this repo
 * puts in its `gridTemplateColumns`.
 *
 * It is NOT what the pin's offset is derived from — that comes off the caller's
 * own declared track (see {@link resolveLeadingUtilityPinOffset}) — only the
 * fallback for a template whose leading track is not a plain length, and so
 * offers no anchor to read.
 */
export const PINNED_LEAD_UTILITY_TRACK_WIDTH = "36px";

/**
 * The pinned column's right-hand rule.
 *
 * Pinning does not merely fail to ADD a scroll affordance — without this it
 * REMOVES one. At `scrollLeft: 0` the first data cell's `border-l` sits exactly
 * on the pinned column's right edge; the moment the table scrolls, that cell
 * slides away underneath and the pinned column is left with no edge at all,
 * against content that is visibly moving.
 *
 * Drawn as a 1px strip offset by `-right-px` so it lands ON the pixel the
 * neighbour's `border-l` occupies rather than beside it: nothing doubles to 2px
 * at rest, and the rule survives the scroll. Same construction
 * `TableGridHeaderColumn` already uses for its drop-target marker.
 */
export const PINNED_LEAD_EDGE_CLASS =
  "after:pointer-events-none after:absolute after:inset-y-0 after:-right-px after:w-px after:bg-border";

/**
 * The tint overlay's geometry, minus any colour — the colour is whichever of
 * the state classes below applies, so an un-hovered, unselected pinned cell
 * renders a fully transparent overlay and shows the surface token alone.
 *
 * `-z-10` puts it in the negative-z layer of the pinned cell's stacking
 * context: above the cell's own background, below its content.
 * `pointer-events-none` keeps it from swallowing the clicks and hovers the row
 * and the lead cell's own link are entitled to.
 */
export const PINNED_LEAD_TINT_CLASS =
  "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:content-['']";

/**
 * The hover tint, restating the row's `hover:bg-muted/40`. Scoped to
 * `group-hover` because the hover that matters is the ROW's, not the pinned
 * cell's — a pointer over the Status column must tint the pinned name too, or
 * the one cell that identifies the row is the one cell that does not respond.
 */
export const PINNED_LEAD_HOVER_TINT_CLASS = "group-hover:before:bg-muted/40";

/** Keep the pinned header opaque while retaining its existing hover fade. */
export const PINNED_LEAD_HEADER_HOVER_TINT_CLASS =
  "before:transition-colors hover:before:bg-muted/40";

/**
 * The selected tint, restating the row's `bg-primary/10`. Unconditional rather
 * than `group-hover`, mirroring how selection BEATS hover on the row itself: a
 * selected row keeps its tint when the pointer crosses it instead of flicking to
 * the neutral hover grey, and the pinned cell has to make the same choice or it
 * would flick alone.
 */
export const PINNED_LEAD_SELECTED_TINT_CLASS = "before:bg-primary/10";

/**
 * The ROW's own hover tint, and the owner of the `muted/40` token.
 *
 * It lives here rather than inline in `GridTable` so it sits in sight of
 * {@link PINNED_LEAD_HOVER_TINT_CLASS} and
 * {@link PINNED_LEAD_HEADER_HOVER_TINT_CLASS}, which must restate the same token
 * for the pinned cells to read as part of their row or header. Tailwind scans this directory
 * (`@source "../**\/*.{ts,tsx}"`), so an exported literal generates exactly as
 * an inline one — and a computed `group-hover:before:${token}` would generate
 * nothing, which is why the pinned half has to be a second literal rather than
 * a reference. These literals must agree and stay adjacent; that is the most a
 * statically-scanned class system allows.
 */
export const ROW_HOVER_TINT_CLASS = "hover:bg-muted/40";

/**
 * The ROW's selected tint, and the owner of the `primary/10` token. Restates
 * itself in the hover slot because selection BEATS hover: without it the row
 * flips to the neutral hover grey as the pointer crosses, so a selected row
 * appears to deselect itself on mouseover. Paired with
 * {@link PINNED_LEAD_SELECTED_TINT_CLASS}, which mirrors it on the pinned cell.
 */
export const ROW_SELECTED_TINT_CLASS = "bg-primary/10 hover:bg-primary/10";

/**
 * The shared tint overlay for both halves of a pinned leading region.
 *
 * The utility and identity cells sit side by side, so they must select the
 * same row-state tint or one row reads as two differently shaded cells.
 */
export function pinnedLeadTintClasses(
  selected: boolean
): readonly string[] {
  return [
    PINNED_LEAD_TINT_CLASS,
    selected ? PINNED_LEAD_SELECTED_TINT_CLASS : PINNED_LEAD_HOVER_TINT_CLASS,
  ];
}

/**
 * The first track of a `grid-template-columns` string, tolerating the one
 * space a function-valued track carries inside it (`minmax(300px, 1fr)`) — a
 * plain split on whitespace would return `minmax(300px,` as the track.
 */
const LEADING_TRACK_PATTERN = /^\s*([^\s(]+(?:\([^)]*\))?)/;

/**
 * A plain CSS length, which is the only thing a sticky `left` can be anchored
 * to. A leading track declared `1fr`, `auto`, `%` or `minmax(…)` resolves to a
 * width only the layout engine knows, and `left: 1fr` is an invalid
 * declaration the browser drops — leaving the cell at its static offset,
 * scrolling away, which is the defect the pin exists to prevent.
 */
const CSS_LENGTH_PATTERN = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|ch|vw|vmin|vmax)$/;

/**
 * The `left` a pinned identity cell parks at when a leading utility cell holds
 * the edge beside it: the width the CALLER declared for that track, read off
 * the very `gridTemplateColumns` the grid is laid out on, so the anchor and the
 * track it clears cannot disagree.
 *
 * Reading the template rather than assuming a width is what keeps the pin
 * honest for a consumer that declares something other than
 * {@link PINNED_LEAD_UTILITY_TRACK_WIDTH}: `gridTemplateColumns` is arbitrary
 * and is not part of any narrower contract, so a 52px utility track must move
 * the identity cell 52px or the two pinned cells overlap.
 *
 * Falls back to that documented width when the leading track is not a plain
 * length — there is no anchor to derive, and an invalid `left` would silently
 * unpin the cell rather than misplace it.
 */
export function resolveLeadingUtilityPinOffset(
  gridTemplateColumns: string
): string {
  const leadingTrack = LEADING_TRACK_PATTERN.exec(gridTemplateColumns)?.[1];
  if (leadingTrack !== undefined && CSS_LENGTH_PATTERN.test(leadingTrack)) {
    return leadingTrack;
  }
  return PINNED_LEAD_UTILITY_TRACK_WIDTH;
}
