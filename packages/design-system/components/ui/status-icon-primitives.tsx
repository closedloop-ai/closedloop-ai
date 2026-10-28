"use client";

import * as React from "react";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  CENTER,
  CIRCUMFERENCE,
  EMPTY_RING_TRACK_COLOR as SHARED_EMPTY_RING_TRACK_COLOR,
  FilledBoltCircle,
  FilledCheckCircle,
  FilledExclamationCircle,
  FilledSwapCircle,
  FilledXCircle,
  INNER_CIRCUMFERENCE,
  INNER_PATH_RADIUS,
  INNER_STROKE_WIDTH,
  NO_MEASURE_DASH_COLOR,
  NO_MEASURE_DASH_HALF_LENGTH,
  RADIUS,
  STROKE_WIDTH,
} from "./internal/status-icon-shared";

export { EMPTY_RING_TRACK_COLOR } from "./internal/status-icon-shared";

/**
 * Generic, domain-agnostic building blocks for status icons: a progress ring
 * (`StatusRing`), a filled glyph circle (`FilledStatusCircle`), and a
 * no-measure dash (`StatusDash`).
 *
 * These render only from visual props — they know nothing about Documents,
 * Features, or any other domain vocabulary. Domain status-icon components
 * (`@repo/app/documents/components/*-status-icon`) map a domain status to one
 * of these primitives. Keep this file free of domain concepts.
 */

/** Glyph rendered inside a filled status circle. */
export type StatusGlyph = "check" | "x" | "swap" | "exclamation" | "bolt";

const STATUS_GLYPHS: Record<StatusGlyph, (fill: string) => React.ReactNode> = {
  check: (fill) => <FilledCheckCircle fill={fill} />,
  x: (fill) => <FilledXCircle fill={fill} />,
  swap: (fill) => <FilledSwapCircle fill={fill} />,
  exclamation: (fill) => <FilledExclamationCircle fill={fill} />,
  bolt: (fill) => <FilledBoltCircle fill={fill} />,
};

interface StatusRingProps
  extends Omit<React.SVGAttributes<SVGSVGElement>, "color"> {
  /** Fill amount, 0–100. 0 renders an empty (or dashed) track. */
  percentage: number;
  /** Arc + inner-pie color (e.g. "var(--progress-foreground)"). */
  color: string;
  /** Accessible label for the icon. */
  label: string;
  /** Dashed track — the "backlog" look. */
  dashed?: boolean;
  /**
   * Spinning arc for AI/agent processing. Replaces the progress arc; the inner
   * pie stays visible. Intended for non-terminal states only.
   */
  thinking?: boolean;
  /** Icon size in pixels (default 16). */
  size?: 16 | 20;
  /** Override the track (background circle) color. Defaults to var(--progress). */
  trackColor?: string;
  /** Override the ring track/arc stroke width. Defaults to 2. */
  ringStrokeWidth?: number;
}

/**
 * Circular progress ring: an outer track, an outer progress arc, and an inner
 * pie that together read as a percentage-complete marker.
 */
export function StatusRing({
  percentage,
  color,
  label,
  dashed = false,
  thinking = false,
  size = 16,
  trackColor,
  ringStrokeWidth,
  className,
  ...props
}: StatusRingProps) {
  const sw = ringStrokeWidth ?? STROKE_WIDTH;
  const outerOffset = CIRCUMFERENCE * (1 - percentage / 100);
  const innerOffset = INNER_CIRCUMFERENCE * (1 - percentage / 100);
  const spinnerDash = CIRCUMFERENCE * 0.25;
  const spinnerGap = CIRCUMFERENCE - spinnerDash;
  const hasArc = percentage > 0;

  return (
    <svg
      aria-label={label}
      className={cn("shrink-0", className)}
      data-slot="status-icon"
      fill="none"
      height={size}
      role="img"
      viewBox="0 0 20 20"
      width={size}
      {...props}
    >
      {/* Outer track circle */}
      <circle
        cx={CENTER}
        cy={CENTER}
        fill="none"
        r={RADIUS}
        stroke={trackColor ?? "var(--progress)"}
        strokeDasharray={dashed ? "3 3" : undefined}
        strokeWidth={sw}
      />
      {/* Outer progress arc — hidden when thinking (replaced by spinner) */}
      {!thinking && hasArc && (
        <circle
          className="transition-all duration-300 ease-in-out"
          cx={CENTER}
          cy={CENTER}
          fill="none"
          r={RADIUS}
          stroke={color}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={outerOffset}
          strokeLinecap="round"
          strokeWidth={sw}
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
        />
      )}
      {/* Thinking spinner — replaces outer progress arc */}
      {thinking && (
        <circle
          className="origin-center animate-spin"
          cx={CENTER}
          cy={CENTER}
          fill="none"
          r={RADIUS}
          stroke="var(--thinking)"
          strokeDasharray={`${spinnerDash} ${spinnerGap}`}
          strokeLinecap="round"
          strokeWidth={sw}
        />
      )}
      {/* Inner filled pie — always visible for arc states */}
      {hasArc && (
        <circle
          className="transition-all duration-300 ease-in-out"
          cx={CENTER}
          cy={CENTER}
          fill="none"
          r={INNER_PATH_RADIUS}
          stroke={color}
          strokeDasharray={INNER_CIRCUMFERENCE}
          strokeDashoffset={innerOffset}
          strokeWidth={INNER_STROKE_WIDTH}
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
        />
      )}
    </svg>
  );
}

interface FilledStatusCircleProps extends React.SVGAttributes<SVGSVGElement> {
  /** Which glyph to render inside the filled circle. */
  glyph: StatusGlyph;
  /** Circle fill color. The glyph is drawn in var(--background). */
  fill: string;
  /** Accessible label for the icon. */
  label: string;
  /** Icon size in pixels (default 16). */
  size?: 16 | 20;
}

/** Solid-filled circle with a centered white glyph — used for terminal states. */
export function FilledStatusCircle({
  glyph,
  fill,
  label,
  size = 16,
  className,
  ...props
}: FilledStatusCircleProps) {
  return (
    <svg
      aria-label={label}
      className={cn("shrink-0", className)}
      data-slot="status-icon"
      fill="none"
      height={size}
      role="img"
      viewBox="0 0 20 20"
      width={size}
      {...props}
    >
      {STATUS_GLYPHS[glyph](fill)}
    </svg>
  );
}

interface StatusDashProps
  extends Omit<React.SVGAttributes<SVGSVGElement>, "color"> {
  /** Accessible label for the icon. Names what has nothing to measure. */
  label: string;
  /** Icon size in pixels (default 16). */
  size?: 16 | 20;
  /**
   * Dash color. Defaults to the muted no-measure tone — the only tone this mark
   * has needed so far. Exposed like `StatusRing.color` / `FilledStatusCircle.fill`
   * so a caller that needs a different tone tunes THIS primitive instead of
   * hand-rolling a second `<line>` next to it.
   */
  color?: string;
}

/**
 * A single muted dash, centered in the same box a `StatusRing` occupies - the
 * mark for a population with nothing to measure (a zero denominator), as
 * opposed to a real zero.
 *
 * Why a dash and not another ring variant: every ring on this surface, dashed
 * or solid, faint or muted, is the same silhouette. At 16px a dashed-vs-solid
 * or faint-vs-muted delta is a texture difference the eye loses in a dense
 * table, which leaves the tooltip carrying the meaning and the glyph as
 * decoration. A dash reads as a different SHAPE at any size, in either theme,
 * so it cannot be mistaken for a backlog ring or a 0% ring. It is also the more
 * honest mark: a ring implies a measurable denominator, and there isn't one.
 *
 * Same viewBox and box size as the ring, so it drops into a ring's slot without
 * reflowing the row.
 */
export function StatusDash({
  label,
  size = 16,
  color = NO_MEASURE_DASH_COLOR,
  className,
  ...props
}: StatusDashProps) {
  return (
    <svg
      aria-label={label}
      className={cn("shrink-0", className)}
      data-slot="status-icon"
      fill="none"
      height={size}
      role="img"
      viewBox="0 0 20 20"
      width={size}
      {...props}
    >
      <line
        stroke={color}
        strokeLinecap="round"
        strokeWidth={STROKE_WIDTH}
        x1={CENTER - NO_MEASURE_DASH_HALF_LENGTH}
        x2={CENTER + NO_MEASURE_DASH_HALF_LENGTH}
        y1={CENTER}
        y2={CENTER}
      />
    </svg>
  );
}

/**
 * A single visual treatment for a status mark: which primitive draws it and the
 * visual props that primitive needs. Purely visual — no member names a domain
 * status, so this stays inside the package's domain-free scope rule.
 */
type StatusIconTreatment =
  | {
      readonly kind: "glyph";
      readonly glyph: StatusGlyph;
      /** CSS-var fill token for the circle. */
      readonly fill: string;
    }
  | {
      readonly kind: "ring";
      /** CSS-var arc/inner-pie token. Inert where `percentage` is 0. */
      readonly color: string;
      /** Fill amount, 0-100. Stated on every arm, like `StatusRing` requires. */
      readonly percentage: number;
      /** Dashed track — the lowest-commitment ring. */
      readonly dashed?: boolean;
      /** Track (background circle) color override. */
      readonly trackColor?: string;
      /** Ring track/arc stroke width override. */
      readonly ringStrokeWidth?: number;
    };

/** Arc/inner-pie tone every measurable ring in this family draws. */
export const PROGRESS_RING_COLOR = "var(--progress-foreground)";

/**
 * The named visual vocabulary a status mark can take, keyed by what it DRAWS
 * rather than by what any one domain calls it. This layer owns the tuple; a
 * domain adapter owns which name each of its statuses maps to and that status's
 * label. A glyph name states the token it paints, so the two cannot drift.
 */
export type StatusAppearance =
  | "dashed-ring"
  | "blank-ring"
  | "empty-ring"
  | "quarter-ring"
  | "half-ring"
  | "three-quarter-ring"
  | "full-ring"
  | "muted-half-ring"
  | "success-check"
  | "warning-exclamation"
  | "foreground-x"
  | "ai-swap"
  | "destructive-bolt";

const STATUS_APPEARANCES: Record<StatusAppearance, StatusIconTreatment> = {
  "dashed-ring": {
    kind: "ring",
    color: PROGRESS_RING_COLOR,
    percentage: 0,
    dashed: true,
  },
  // Parts from `empty-ring` on track tone alone — about 1.5:1 between two
  // identical silhouettes, so the pair does NOT separate at 16px and nothing
  // here claims it does. Only a domain adapter's unknown-status fallback
  // reaches it, and their maps exclude it by type.
  "blank-ring": { kind: "ring", color: PROGRESS_RING_COLOR, percentage: 0 },
  "empty-ring": {
    kind: "ring",
    color: PROGRESS_RING_COLOR,
    percentage: 0,
    trackColor: SHARED_EMPTY_RING_TRACK_COLOR,
  },
  // Half and three-quarter stops use 48.5 and 73.5, not 50 and 75: the
  // arc's round `strokeLinecap` overshoots by half a stroke at each end.
  // Quarter stays at 25 because the small arc needs the named stop more than
  // the optical correction. One edit here repoints every family drawing it.
  "quarter-ring": {
    kind: "ring",
    color: PROGRESS_RING_COLOR,
    percentage: 25,
  },
  "half-ring": { kind: "ring", color: PROGRESS_RING_COLOR, percentage: 48.5 },
  "three-quarter-ring": {
    kind: "ring",
    color: PROGRESS_RING_COLOR,
    percentage: 73.5,
  },
  "full-ring": { kind: "ring", color: PROGRESS_RING_COLOR, percentage: 100 },
  // Muted tone, thinner stroke, and the same 48.5% geometry as `half-ring` —
  // so it does read as a position, which is why the name says `half`.
  "muted-half-ring": {
    kind: "ring",
    color: "var(--muted-foreground)",
    percentage: 48.5,
    ringStrokeWidth: 1.5,
    trackColor: "var(--muted-foreground)",
  },
  "success-check": { kind: "glyph", glyph: "check", fill: "var(--success)" },
  "warning-exclamation": {
    kind: "glyph",
    glyph: "exclamation",
    fill: "var(--warning)",
  },
  "foreground-x": { kind: "glyph", glyph: "x", fill: "var(--foreground)" },
  "ai-swap": { kind: "glyph", glyph: "swap", fill: "var(--ai)" },
  // Within the artifact status families, the only mark for
  // terminal-and-went-wrong — so it parts from `foreground-x` and
  // `warning-exclamation` on SHAPE, not hue alone (WCAG 1.4.1). Other
  // vocabularies pair differently; see the ledger.
  "destructive-bolt": {
    kind: "glyph",
    glyph: "bolt",
    fill: "var(--destructive)",
  },
};

/**
 * Every appearance name, at runtime. A `Record<StatusAppearance, …>` is checked
 * by `tsc`, which a vitest run does not invoke — so a consumer covering the
 * whole vocabulary derives its list here instead of hand-copying the union and
 * silently going one short.
 */
export const STATUS_APPEARANCE_NAMES = Object.keys(
  STATUS_APPEARANCES
) as readonly StatusAppearance[];

interface StatusAppearanceIconProps
  extends Omit<React.SVGAttributes<SVGSVGElement>, "color" | "fill"> {
  /** Which named visual treatment to draw. */
  appearance: StatusAppearance;
  /** Accessible label for the icon. The caller's vocabulary, not this layer's. */
  label: string;
  /** Icon size in pixels (default 16). */
  size?: 16 | 20;
  /** Spinning arc for AI/agent processing. Ignored by glyph appearances. */
  thinking?: boolean;
}

/**
 * Draws one named {@link StatusAppearance}. This is the single seam every
 * status-icon family renders through, so a change to what an appearance draws
 * lands on all of them at once instead of on whichever copy was edited.
 *
 * The registry supplies defaults, then `props` spreads last to preserve the
 * public wrapper API's historical escape hatch for deliberate SVG overrides.
 * Omitting `color` and `fill` still rejects the literal form; a spread of a
 * wider object can override visual props by design.
 */
export function StatusAppearanceIcon({
  appearance,
  label,
  size = 16,
  thinking = false,
  ...props
}: StatusAppearanceIconProps) {
  const treatment = hasStatusAppearance(appearance)
    ? STATUS_APPEARANCES[appearance]
    : STATUS_APPEARANCES["blank-ring"];

  if (treatment.kind === "glyph") {
    return (
      <FilledStatusCircle
        fill={treatment.fill}
        glyph={treatment.glyph}
        label={label}
        size={size}
        {...props}
      />
    );
  }

  return (
    <StatusRing
      color={treatment.color}
      dashed={treatment.dashed}
      label={label}
      percentage={treatment.percentage}
      ringStrokeWidth={treatment.ringStrokeWidth}
      size={size}
      thinking={thinking}
      trackColor={treatment.trackColor}
      {...props}
    />
  );
}

function hasStatusAppearance(
  appearance: StatusAppearance
): appearance is StatusAppearance {
  return Object.hasOwn(STATUS_APPEARANCES, appearance);
}
