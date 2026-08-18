/**
 * Whole-column fold fitting for the `GridTable` primitive (ISS-4889).
 *
 * A `GridTable` is a CSS grid whose rows are `min-w-fit`, so when the declared
 * tracks are wider than the host's scroll viewport the grid overflows and the
 * viewport's right edge — "the fold" — lands wherever it lands. In the general
 * case that is somewhere in the MIDDLE of a track, so at rest (`scrollLeft` 0)
 * one column is rendered partially: a chip clipped to half a word, or, worse, a
 * currency figure clipped mid-glyph so `$772.39` reads as `$772.3` (ISS-4788).
 * Reordering columns only chooses WHICH column is cut.
 *
 * This module removes the condition instead. Given the caller's
 * `gridTemplateColumns` and the measured container width, it finds the largest
 * whole-column prefix that fits and widens the LEADING track by the leftover, so
 * the fold lands exactly on a column boundary. Nothing is hidden and nothing is
 * dropped: every column past the fold is still reachable by scrolling, in the
 * same order, at the same width.
 *
 * The LEADING track absorbs the leftover, and the alternatives all end up lying
 * about a width somebody declared:
 *  - it is the one track a `GridTable` caller already declares flexible
 *    (`minmax(300px, 1fr)`), and it carries the row's name — the value that most
 *    wants the extra room;
 *  - it is the only track that can never carry a persisted user resize
 *    (FEA-4168's `columnWidths` is data-columns-only), so widening it cannot
 *    contradict a width the user chose. Spreading the leftover proportionally
 *    across the data columns would render every one of them at a width nobody
 *    asked for AND desync the resize handle's base from what is on screen;
 *  - widening the last fitted column instead would move the widened column as
 *    the window resizes, and a right-aligned value in it (Cost) would drift.
 *
 * Everything here is a pure function over the template string, so it is unit
 * testable without a layout engine and carries no React or DOM dependency.
 *
 * Assumes the grid has NO column gap — the tracks are the whole width, which is
 * what `GridTable` renders today (its header and row grids set no `gap`). A
 * caller that adds one via `className` would move the real fold by
 * `(trackCount - 1) x gap` with no failure signal.
 */

/**
 * One `gridTemplateColumns` track: a `minmax(...)` function (matched whole, so
 * the comma inside it never splits a track in two) or a bare token such as
 * `180px` / `1fr`.
 */
const GRID_TRACK_PATTERN = /minmax\([^)]*\)|\S+/g;

/**
 * The first `<n>px` length inside a track, used to REWRITE the leading track's
 * minimum. Only ever applied to a track that already satisfied
 * {@link readTrackMinPxWidth}, whose accepted grammar guarantees the first px
 * length in the token IS the minimum — so replacing the first match can never
 * rewrite a maximum.
 */
const TRACK_MIN_PX_PATTERN = /(\d+(?:\.\d+)?)px/;

/**
 * A track that is nothing but a px length: `180px`, `52px`, `104.5px`.
 * Anchored, so a token that merely CONTAINS a px length does not match.
 */
const BARE_PX_TRACK_PATTERN = /^(\d+(?:\.\d+)?)px$/;

/**
 * A `minmax()` track whose FIRST argument — the minimum — is a px length:
 * `minmax(300px, 1fr)`. Anchored at the minimum position specifically, so
 * `minmax(auto, 300px)` does NOT match: its px length is the maximum.
 */
const MINMAX_PX_MIN_TRACK_PATTERN = /^minmax\(\s*(\d+(?:\.\d+)?)px\s*,/;

/** A grid needs a leading track plus at least one data track to have a fold. */
const MIN_FOLDABLE_TRACK_COUNT = 2;

/** Split a `gridTemplateColumns` value into its individual track tokens. */
export function splitGridTracks(template: string): string[] {
  return template.match(GRID_TRACK_PATTERN) ?? [];
}

/**
 * Each track's resolved pixel width when the grid overflows its container, in
 * render order — i.e. every track pinned to its declared px minimum, since an
 * overflowing grid has no free space to distribute to a `fr` maximum.
 *
 * Returns `null` when ANY track falls outside the grammar this module can
 * actually measure (see {@link readTrackMinPxWidth}) — `1fr`, `auto`,
 * `minmax(0, 1fr)`, `minmax(min(100%, 28rem), 1fr)`, and equally
 * `minmax(auto, 300px)` or `var(--lead, 300px)`, whose px length is NOT the
 * minimum. Such a template's rendered geometry cannot be derived from the string
 * alone, and guessing would move columns for the wrong reason — so callers
 * degrade to leaving the template untouched rather than fitting it on a bad
 * measurement.
 */
export function parseGridTrackMinWidthsPx(template: string): number[] | null {
  const tracks = splitGridTracks(template);
  if (tracks.length === 0) {
    return null;
  }
  const widths: number[] = [];
  for (const track of tracks) {
    const width = readTrackMinPxWidth(track);
    if (width === null) {
      return null;
    }
    widths.push(width);
  }
  return widths;
}

/**
 * How many leading tracks fit WHOLE inside `containerWidthPx`, and how many
 * pixels of the container are left over after them. `fittedCount` of `0` means
 * not even the first track fits.
 */
export function measureWholeColumnFold(
  trackWidthsPx: readonly number[],
  containerWidthPx: number
): { fittedCount: number; leftoverPx: number } {
  let fittedCount = 0;
  let consumed = 0;
  for (const width of trackWidthsPx) {
    if (consumed + width > containerWidthPx) {
      break;
    }
    consumed += width;
    fittedCount += 1;
  }
  return { fittedCount, leftoverPx: containerWidthPx - consumed };
}

/**
 * Widen the leading track of `template` so the container's right edge lands on a
 * column boundary — no track is rendered partially visible at rest (ISS-4889).
 *
 * Returns the template UNCHANGED (byte-identical) whenever fitting would be
 * wrong or unnecessary, so a caller can apply it unconditionally:
 *  - the measured width is not a usable positive number (first paint, a
 *    detached/zero-size container, a `NaN` from a bad measurement);
 *  - the grid already fits — there is no fold, and the `fr` maximums are
 *    entitled to the free space;
 *  - the fold already sits exactly on a boundary (leftover 0);
 *  - not even the leading track fits, so there is no whole column to snap to and
 *    widening the lead would only push MORE content off-screen;
 *  - a track carries no px length, so {@link parseGridTrackMinWidthsPx} cannot
 *    measure the row (see its note).
 *
 * The widened lead is floored to a whole pixel, so the emitted template is
 * stable AND the sub-pixel it gives up is one-sided: the fitted prefix lands at
 * or before the container's right edge, never past it. Rounding would take the
 * widened lead UP whenever the leftover's fraction is 0.5 or more — and
 * `containerWidthPx` is fractional in a real browser, since it comes from
 * `ResizeObserver`'s `contentRect` — which would clip the last "whole" column by
 * up to half a pixel instead of ending it exactly on the fold.
 */
export function fitGridTemplateToWholeColumns(
  template: string,
  containerWidthPx: number
): string {
  if (!Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
    return template;
  }
  const trackWidthsPx = parseGridTrackMinWidthsPx(template);
  if (!trackWidthsPx || trackWidthsPx.length < MIN_FOLDABLE_TRACK_COUNT) {
    return template;
  }
  const totalPx = trackWidthsPx.reduce((total, width) => total + width, 0);
  if (totalPx <= containerWidthPx) {
    return template;
  }
  const { fittedCount, leftoverPx } = measureWholeColumnFold(
    trackWidthsPx,
    containerWidthPx
  );
  if (fittedCount === 0 || leftoverPx <= 0) {
    return template;
  }
  return growLeadingTrack(template, trackWidthsPx[0] + leftoverPx);
}

/**
 * Rewrite the leading track's px length to `widthPx`, preserving the rest of the
 * track verbatim — `minmax(300px, 1fr)` becomes `minmax(336px, 1fr)`, a bare
 * `300px` becomes `336px` — and leaving every other track untouched.
 *
 * Floored, not rounded: see {@link fitGridTemplateToWholeColumns}. Flooring is
 * what keeps the emitted prefix at or before the container edge for a fractional
 * container width, so the last fitted column is never clipped by a sub-pixel.
 */
function growLeadingTrack(template: string, widthPx: number): string {
  const tracks = splitGridTracks(template);
  const [lead, ...rest] = tracks;
  const grown = lead.replace(TRACK_MIN_PX_PATTERN, `${Math.floor(widthPx)}px`);
  return [grown, ...rest].join(" ");
}

/**
 * A single track's declared MINIMUM width in px, or `null` when the track is
 * outside the grammar this module can measure.
 *
 * Deliberately a whitelist of two forms — a bare `<n>px`, and a `minmax()` whose
 * FIRST argument is a px length — rather than "the first px length anywhere in
 * the token". The looser reading is wrong in both directions, and silently so:
 * `minmax(auto, 300px)` would be read as a 300px minimum when 300px is its
 * MAXIMUM (the track's real minimum is `auto`, i.e. content-dependent), and
 * `var(--lead, 300px)` would be read as 300px when the custom property can
 * resolve to anything. In either case the module would claim the fold is snapped
 * to a column boundary while the browser lays the row out somewhere else — worse
 * than declining, because the caller gets no failure signal.
 *
 * Both accepted forms put the px length the caller means FIRST in the token,
 * which is the invariant {@link TRACK_MIN_PX_PATTERN} relies on when rewriting
 * the leading track.
 */
function readTrackMinPxWidth(track: string): number | null {
  const bare = track.match(BARE_PX_TRACK_PATTERN);
  if (bare) {
    return Number(bare[1]);
  }
  const minmaxPxMin = track.match(MINMAX_PX_MIN_TRACK_PATTERN);
  if (minmaxPxMin) {
    return Number(minmaxPxMin[1]);
  }
  return null;
}
