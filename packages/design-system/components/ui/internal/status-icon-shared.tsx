import * as React from "react";

export const CENTER = 10;
export const RADIUS = 9;
export const STROKE_WIDTH = 2;
export const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const INNER_PATH_RADIUS = 3;
export const INNER_STROKE_WIDTH = INNER_PATH_RADIUS * 2;
export const INNER_CIRCUMFERENCE = 2 * Math.PI * INNER_PATH_RADIUS;

export const ICON_STROKE_WIDTH = 1.66;

/**
 * Track (background circle) color for low-emphasis empty rings — the Todo
 * (Feature) and Draft (Document) states. A muted-foreground tint that stays
 * legible without competing with filled/progress states. Read once, by the
 * `empty-ring` entry in the appearance registry.
 */
export const EMPTY_RING_TRACK_COLOR =
  "color-mix(in oklch, var(--muted-foreground) 40%, transparent)";

/** Filled circle with a white check mark — used for 100%/complete states. */
export function FilledCheckCircle({ fill }: { fill: string }) {
  return (
    <>
      <circle cx={CENTER} cy={CENTER} r={RADIUS + STROKE_WIDTH / 2} fill={fill} />
      <path
        d="M6.5 10.5L9.5 13.5L14 7.5"
        stroke="var(--background)"
        strokeWidth={ICON_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </>
  );
}

/** Filled circle with a white X mark — used for wont-do states. */
export function FilledXCircle({ fill }: { fill: string }) {
  return (
    <>
      <circle cx={CENTER} cy={CENTER} r={RADIUS + STROKE_WIDTH / 2} fill={fill} />
      <path
        d="M7 7L13 13M13 7L7 13"
        stroke="var(--background)"
        strokeWidth={ICON_STROKE_WIDTH}
        strokeLinecap="round"
        fill="none"
      />
    </>
  );
}

/**
 * Filled circle with a white double-headed arrow glyph (↔) — used for triage
 * states: a single horizontal stem with a chevron arrowhead on each end.
 */
export function FilledSwapCircle({ fill }: { fill: string }) {
  return (
    <>
      <circle cx={CENTER} cy={CENTER} r={RADIUS + STROKE_WIDTH / 2} fill={fill} />
      <path
        d="M5 10H15M7.5 7.5L5 10L7.5 12.5M12.5 7.5L15 10L12.5 12.5"
        stroke="var(--background)"
        strokeWidth={ICON_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </>
  );
}

/**
 * Filled circle with a white exclamation mark — the blocked / changes-requested
 * states, filled with `--warning`.
 *
 * ISS-8692 briefly pointed `failed` at this same path in `--destructive`. The
 * ISS-6801 decision-maker ruled on 2026-09-01 that Failed gets a mark of its
 * own, so it draws {@link FilledBoltCircle} instead and this path is back to a
 * single meaning. Do not re-point a second status at it: two states that part
 * on fill alone part on hue alone (WCAG 1.4.1).
 */
export function FilledExclamationCircle({ fill }: { fill: string }) {
  return (
    <>
      <circle cx={CENTER} cy={CENTER} r={RADIUS + STROKE_WIDTH / 2} fill={fill} />
      <path
        d="M10 5.5V11"
        stroke="var(--background)"
        strokeWidth={ICON_STROKE_WIDTH}
        strokeLinecap="round"
        fill="none"
      />
      <circle cx={CENTER} cy={14} r={0.9} fill="var(--background)" />
    </>
  );
}

/**
 * Filled circle with a white lightning bolt — the `failed` status (ISS-8692, on
 * the ISS-6801 decision-maker's 2026-09-01 ruling that Failed gets a mark of
 * its own rather than sharing the exclamation with `--warning` Blocked).
 *
 * Why a new shape and not a recolour: the artifact table can draw Failed one
 * row from Blocked and Changes requested, and at 16px a hue delta between two
 * identical silhouettes is texture the eye loses in a dense table — the same
 * reasoning {@link NO_MEASURE_DASH_COLOR}'s dash gives for separating by
 * silhouette. A bolt differs in SHAPE at any size and in either theme, so the
 * pair cannot part on hue alone (WCAG 1.4.1). It is also the conventional
 * fault mark, where the neighbouring X (`wont-do`) reads as
 * terminal-by-decision rather than terminal-and-went-wrong.
 *
 * A solid path rather than a stroked zigzag: at 16px the stroked form closes up
 * into a blob. It spans y 5.2–14.8, just inside the exclamation's own inked
 * extent — that mark's stem is `M10 5.5V11` with a round cap and its dot is
 * `cy=14 r=0.9`, so it actually inks y 4.67–14.9, not the 5.2–14.8 an earlier
 * revision of this comment claimed.
 *
 * KNOWN, and NOT settled here: bounding-box parity is not optical parity. Both
 * apexes are acute wedges opening about 0.6 units per unit of height, so within
 * ~1.4 units of either tip the ink is under one device pixel at 16px, where
 * every other glyph in this family holds {@link ICON_STROKE_WIDTH} end to end.
 * Blunting the tips to that weight is not reachable by moving these six points:
 * inset by half a stroke, this polygon collapses through its own centre. It
 * needs a longer or heavier mark, which is a change to the SHAPE and belongs to
 * whoever owns the 2026-09-01 ruling, not to this file. See PR #6397.
 */
export function FilledBoltCircle({ fill }: { fill: string }) {
  return (
    <>
      <circle cx={CENTER} cy={CENTER} r={RADIUS + STROKE_WIDTH / 2} fill={fill} />
      <path
        d="M11.6 5.2L6.8 10.8H9.4L8.4 14.8L13.2 9.2H10.6Z"
        fill="var(--background)"
      />
    </>
  );
}

/**
 * Half-length of the "nothing to measure" dash, in viewBox units. The dash spans
 * `CENTER ± this`, so it reads as a deliberate mark rather than a hairline while
 * staying clear of where a ring's stroke would sit.
 */
export const NO_MEASURE_DASH_HALF_LENGTH = 5;

/**
 * Stroke color for the "nothing to measure" dash. Full-strength
 * `--muted-foreground`, not the 40% `EMPTY_RING_TRACK_COLOR`: the ring track is
 * a backdrop behind an arc and can afford to be faint, but the dash IS the whole
 * mark, so it has to hold 3:1 non-text contrast on its own (WCAG 1.4.11) in both
 * themes.
 */
export const NO_MEASURE_DASH_COLOR = "var(--muted-foreground)";
