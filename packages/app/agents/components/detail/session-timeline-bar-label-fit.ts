/**
 * ISS-5761: whether the Session Timeline's cost rail has room to print its
 * labels without them running into each other.
 *
 * ISS-5563 (PR #4642) moved these labels out of `.sd3-bar2` — where
 * `overflow: hidden` had been clipping them away — into the sibling rail
 * `.sd3-bars2-lbls`, one `flex: 1 1 0` cell per bucket. That is what finally
 * made them paint, and it is also what let them collide: the rail deliberately
 * does not clip ("nothing here clips, so an exact `$0.0025` has the room to be
 * exact"), the label is `white-space: nowrap`, and the cell is exactly as wide
 * as the bar under it. A cell that cannot hold its own label simply spills into
 * its neighbours.
 *
 * That is fine at the bucket counts the rail was reasoned about and fatal at the
 * ones the product actually produces. `SESSION_TRACE_BUCKET_TARGET` is 40 and
 * the producer emits one bucket per five minutes, so any session past ~3h20m
 * pins the strip at 40 columns — roughly 16px a cell on a normal detail width,
 * against a `$8.55` that wants nearly 30px. The labels do not truncate, they
 * ABUT, and two of them read as one number: the reported strip printed
 * `$724.0`, which is `$7` and `$24.0` touching, a figure no bucket holds.
 *
 * So the rail measures itself and prints only when the print is legible. The
 * decision is all-or-nothing per strip rather than per label, because a rail
 * that dropped only the crowded labels would leave the reader unable to tell a
 * cheap bucket (no label by {@link getBarStyle}'s cost threshold) from a
 * crowded one, and unable to compare the ones that survived. When the rail goes
 * quiet the figures are still on the bar itself — every bucket button's
 * accessible name carries its cost, and the hover card carries the split.
 */

/** `font-size` of `.sd3-bar2-lbl` in `styles-session-timeline.css`. */
const BAR_LABEL_FONT_SIZE_PX = 9.5;

/**
 * Per-character advance as a fraction of the font size, for the widest glyph a
 * label can contain.
 *
 * The rail is `font-variant-numeric: tabular-nums` at `font-weight: 600`, so
 * every digit — and, near enough, the `$` — occupies one fixed advance, which is
 * what makes a character count a sound width model here rather than a guess.
 * `0.62em` is that advance measured against the shipped UI face, and it holds
 * within a fraction of a pixel across the labels the rail actually carries:
 * design review measured `$8.55` at 28.9px against an estimate of 29.4, and
 * `$0.0025` at 41.6 against 41.2.
 *
 * It is NOT uniformly conservative, and the docstring used to claim it was. A
 * short label overshoots the other way — `$7` measures 12.8px against an
 * estimate of 11.8 — because `.` and `~` are narrower than a digit and are
 * charged the same, so a label's error scales with how many of those it has
 * rather than with its length. {@link BAR_LABEL_MIN_GUTTER_PX} is what absorbs
 * that residue; do not lean on the estimate alone being an upper bound.
 */
const BAR_LABEL_CHAR_ADVANCE_EM = 0.62;

/**
 * The clear space two neighbouring labels must keep between them.
 *
 * Not zero: labels that merely fail to overlap still read as one run — the
 * reported strip's `$8.55$15.3$20.20` is exactly that. This is the gap at which
 * two 9.5px figures read as two figures.
 */
const BAR_LABEL_MIN_GUTTER_PX = 4;

/** `gap` of `.sd3-bars2-lbls`, which mirrors `.sd3-bars2`. */
const BAR_LABEL_RAIL_GAP_PX = 2;

/**
 * The rendered width of one label, in px.
 *
 * Exported for the regression test, which asserts the no-overlap property this
 * module claims rather than re-deriving the arithmetic from the constants.
 */
export function estimateBarLabelWidthPx(label: string): number {
  return label.length * BAR_LABEL_FONT_SIZE_PX * BAR_LABEL_CHAR_ADVANCE_EM;
}

/**
 * Centre-to-centre distance between two adjacent rail cells.
 *
 * `railWidth = n * cell + (n - 1) * gap`, and the pitch is `cell + gap`, so it
 * falls out as `(railWidth + gap) / n` without needing the cell width itself.
 */
function railPitchPx(railWidth: number, cellCount: number): number {
  return (railWidth + BAR_LABEL_RAIL_GAP_PX) / cellCount;
}

/**
 * The horizontal centre of cell `index`, measured from the rail's left edge.
 *
 * The cell is one pitch wide minus the gap that follows it, and the labels are
 * `text-align: center`, so this is where each printed figure is anchored.
 */
function cellCentrePx(index: number, pitch: number): number {
  return index * pitch + (pitch - BAR_LABEL_RAIL_GAP_PX) / 2;
}

/**
 * Do the printed labels clear each other on a rail of this width?
 *
 * Every label is centred in its own cell, so two labelled cells `k` cells apart
 * have `k * pitch` between their centres and need `(w1 + w2) / 2` of it for the
 * glyphs plus {@link BAR_LABEL_MIN_GUTTER_PX} of clear space. Only CONSECUTIVE
 * labelled cells are compared: a label with blank cells beside it has that much
 * more room, which is why a sparse rail can keep printing at a column count a
 * dense one cannot.
 */
export function barLabelsFit({
  labels,
  railWidth,
}: Readonly<{
  labels: readonly (string | null)[];
  railWidth: number;
}>): boolean {
  // `Number.isFinite` and not just `<= 0` (code review): every `needed >
  // available` comparison against `NaN` is false, so a non-finite width would
  // fall through this loop reporting that the rail has room and print
  // unconditionally — failing OPEN, into the exact defect this prevents.
  if (!(Number.isFinite(railWidth) && railWidth > 0) || labels.length === 0) {
    return false;
  }
  const pitch = railPitchPx(railWidth, labels.length);
  let previousIndex = -1;
  let previousWidth = 0;
  for (const [index, label] of labels.entries()) {
    if (label == null || label.length === 0) {
      continue;
    }
    const width = estimateBarLabelWidthPx(label);
    // The rail's own edges are a constraint too (code review). Nothing here
    // clips, so a wide label in the first or last cell spills out of
    // `.sd3-bars2-wrap` and into the panel beside it — a run of two labels is
    // not the only way this rail can overflow.
    const centre = cellCentrePx(index, pitch);
    if (width / 2 > Math.min(centre, railWidth - centre)) {
      return false;
    }
    if (previousIndex >= 0) {
      const available = (index - previousIndex) * pitch;
      const needed = (previousWidth + width) / 2 + BAR_LABEL_MIN_GUTTER_PX;
      if (needed > available) {
        return false;
      }
    }
    previousIndex = index;
    previousWidth = width;
  }
  return true;
}

/**
 * The labels the rail should actually print at this width, in three states:
 * every label when they all clear each other, otherwise the PEAK alone, and
 * otherwise nothing.
 *
 * The peak-only middle state is design review's call, and it is the one that
 * makes the quiet rail honest. The threshold arrives earlier than the ticket
 * suggests — measured against the real ~936px detail panel it lands around 25
 * columns, so most sessions past about ninety minutes lose every label — and a
 * rail that prints nothing is pixel-identical to the rail a SYNTHESIZED strip
 * renders (ISS-5566), where blank means "this strip may not publish figures at
 * all". One blank band would then mean two different things. One figure over the
 * tallest bar cannot be misread: the peak is its own pointer, so it needs no
 * alignment guesswork, and it answers the question a reader actually brings to a
 * 40-column strip.
 *
 * It is the PEAK and not an arbitrary survivor because thinning to several
 * labels would reintroduce the ambiguity this fix exists to remove — a reader
 * cannot tell a bucket left blank because it was cheap from one left blank
 * because it was crowded. With exactly one label there is nothing to compare it
 * against and nothing to mistake it for.
 *
 * The peak-only array is re-checked rather than assumed to fit: a single label
 * in an edge cell can still overhang the rail, and nothing here clips.
 *
 * The array keeps its LENGTH in every state so the rail still renders one cell
 * per bucket: the cells hold the rail open at its `min-height`, so a resize that
 * flips this decision changes what the rail says without moving the strip
 * underneath it.
 */
export function fitBucketBarLabels({
  labels,
  peakIndex = null,
  railWidth,
}: Readonly<{
  labels: readonly (string | null)[];
  /**
   * The index of the strip's most expensive labelled bucket, or `null` when the
   * caller cannot name one — in which case the rail falls straight from "all" to
   * "none" rather than inventing a peak.
   */
  peakIndex?: number | null;
  railWidth: number;
}>): (string | null)[] {
  if (barLabelsFit({ labels, railWidth })) {
    return [...labels];
  }
  if (peakIndex != null && labels[peakIndex] != null) {
    const peakOnly = labels.map((label, index) =>
      index === peakIndex ? label : null
    );
    if (barLabelsFit({ labels: peakOnly, railWidth })) {
      return peakOnly;
    }
  }
  return labels.map(() => null);
}
