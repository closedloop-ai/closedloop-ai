import { parseGridTrackMinWidthsPx } from "@repo/design-system/lib/column-fold";

/**
 * Shared `GridTable` track geometry for tests (ISS-4889).
 *
 * Several suites assert *where* a rendered grid's columns land — whether the
 * container's right edge (the fold) falls on a column boundary, how far right a
 * must-read value sits. Each needs the same derivation: read the rendered
 * `gridTemplateColumns`, resolve each track to the px width it takes while the
 * grid overflows, and accumulate. Deriving it once here keeps the suites from
 * drifting apart, and routes them through the PRODUCTION parser so a change to
 * how a track is measured cannot pass in a test while failing in the component.
 */

/**
 * Declared pixel width of each grid track, in render order — reading each
 * `minmax()` at its MINIMUM. That is deliberately the worst case rather than the
 * general one: given enough width a `1fr` maximum expands and pushes everything
 * right, but a column can only be cut when the grid overflows, and an
 * overflowing grid has no free space to distribute, so every track sits pinned
 * at exactly these widths.
 *
 * Throws rather than returning a partial reading: a template the parser declines
 * means the assertion built on it would be measuring nothing.
 */
export function trackWidthsPx(gridTemplateColumns: string): number[] {
  const widths = parseGridTrackMinWidthsPx(gridTemplateColumns);
  if (!widths) {
    throw new Error(
      `Grid template has a track with no px minimum: "${gridTemplateColumns}"`
    );
  }
  return widths;
}

/**
 * Right edge of every rendered track, in order, measured from the table's left
 * edge — the positions the fold is allowed to land on. A fold that equals one of
 * these cuts between columns; a fold that falls between two cuts *through* one.
 */
export function columnBoundariesPx(gridTemplateColumns: string): number[] {
  const boundaries: number[] = [];
  let cumulative = 0;
  for (const width of trackWidthsPx(gridTemplateColumns)) {
    cumulative += width;
    boundaries.push(cumulative);
  }
  return boundaries;
}
