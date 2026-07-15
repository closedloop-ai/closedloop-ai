import * as React from "react";

export const CENTER = 10;
export const RADIUS = 9;
export const STROKE_WIDTH = 2;
export const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const INNER_PATH_RADIUS = 3;
export const INNER_STROKE_WIDTH = INNER_PATH_RADIUS * 2;
export const INNER_CIRCUMFERENCE = 2 * Math.PI * INNER_PATH_RADIUS;

export const ICON_STROKE_WIDTH = 1.66;

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

/** Filled circle with a white exclamation mark — used for blocked states. */
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
