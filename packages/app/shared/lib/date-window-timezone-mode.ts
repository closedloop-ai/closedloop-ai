/**
 * ISS-9619 — which day boundary a Sessions/Branches time window means.
 *
 * The rolling presets (`7d`/`30d`/`90d`) name a number of CALENDAR DAYS, and a
 * calendar day only exists relative to a timezone. This module is that missing
 * half of the vocabulary: the window helpers in `format-utils` take one of these
 * and quantize to the matching midnight.
 *
 * Dependency-free on purpose. `format-utils` is imported by broad `"use client"`
 * surfaces, and the toolbar control needs only the labels, so neither pays for a
 * parser to read a two-member vocabulary.
 */

/** The day boundary a window is quantized to. */
export const TimezoneMode = {
  /** The reader's own calendar day, from their device's timezone. */
  Local: "local",
  /** The UTC calendar day — the shipped behaviour, and the default. */
  Utc: "utc",
} as const;

export type TimezoneMode = (typeof TimezoneMode)[keyof typeof TimezoneMode];

/**
 * Render order of the segmented control: Local first, because it is the mode a
 * reader opts IN to; UTC is where every window already starts.
 */
export const TIMEZONE_MODES = [TimezoneMode.Local, TimezoneMode.Utc] as const;

/**
 * UTC, and this is load-bearing rather than incidental: ISS-9619 changes nothing
 * a reader sees until they pick the other mode, so every existing window, query
 * key and period comparison is untouched by the flag being created.
 */
export const DEFAULT_TIMEZONE_MODE: TimezoneMode = TimezoneMode.Utc;

/**
 * The accessible per-option names. They say "day boundary" in WORDS because the
 * distinction is never encoded in hue — a reader who cannot tell the two pills
 * apart by colour still reads which one is selected (WCAG 1.4.1).
 */
export const TIMEZONE_MODE_LABELS: Record<TimezoneMode, string> = {
  [TimezoneMode.Local]: "Local day boundary",
  [TimezoneMode.Utc]: "UTC day boundary",
};

/** Compact labels shown on the pills themselves. */
export const TIMEZONE_MODE_SHORT_LABELS: Record<TimezoneMode, string> = {
  [TimezoneMode.Local]: "Local",
  [TimezoneMode.Utc]: "UTC",
};

/** Accessible name for the control as a whole. */
export const TIMEZONE_MODE_CONTROL_LABEL = "Day boundary";

/**
 * What the control means, for the tooltip. The pills say "Local" and "UTC";
 * neither says whose local, nor what a boundary changes, and the sibling date
 * toggle already explains itself on hover.
 */
export const TIMEZONE_MODE_CONTROL_HINT =
  "Whether the range means your local calendar days or UTC ones";
