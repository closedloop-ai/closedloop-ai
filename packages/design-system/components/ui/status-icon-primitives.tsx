"use client";

import * as React from "react";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  CENTER,
  CIRCUMFERENCE,
  FilledCheckCircle,
  FilledExclamationCircle,
  FilledSwapCircle,
  FilledXCircle,
  INNER_CIRCUMFERENCE,
  INNER_PATH_RADIUS,
  INNER_STROKE_WIDTH,
  RADIUS,
  STROKE_WIDTH,
} from "./internal/status-icon-shared";

/**
 * Generic, domain-agnostic building blocks for circular status icons: a
 * progress ring (`StatusRing`) and a filled glyph circle (`FilledStatusCircle`).
 *
 * These render only from visual props — they know nothing about Documents,
 * Features, or any other domain vocabulary. Domain status-icon components
 * (`@repo/app/documents/components/*-status-icon`) map a domain status to one
 * of these primitives. Keep this file free of domain concepts.
 */

/** Glyph rendered inside a filled status circle. */
export type StatusGlyph = "check" | "x" | "swap" | "exclamation";

const STATUS_GLYPHS: Record<StatusGlyph, (fill: string) => React.ReactNode> = {
  check: (fill) => <FilledCheckCircle fill={fill} />,
  x: (fill) => <FilledXCircle fill={fill} />,
  swap: (fill) => <FilledSwapCircle fill={fill} />,
  exclamation: (fill) => <FilledExclamationCircle fill={fill} />,
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
