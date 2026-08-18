import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { getPhaseDisplay } from "@repo/app/agents/lib/session-activity-phases";

/**
 * ISS-5819 — the Session Timeline's "Group by" dimensions.
 *
 * The strip has always stacked each bar one way: input / output / cache. That is
 * one true answer to "where did the money go", and it is not the only question a
 * reader has — "which MODEL cost that", "which PHASE of the run", "whose session"
 * are the same bar re-cut along a different axis. This module owns all four cuts
 * so a bar and its own hover card cannot disagree about which one is showing.
 *
 * Every grouping sums to the SAME per-column total. That is the invariant worth
 * protecting: re-cutting a bar must never change how tall it is, or the control
 * would look like it was changing the data rather than the view of it.
 */

export const TimelineStackGrouping = {
  TokenType: "token-type",
  Model: "model",
  ActivityPhase: "activity-phase",
  Owner: "owner",
} as const;

export type TimelineStackGrouping =
  (typeof TimelineStackGrouping)[keyof typeof TimelineStackGrouping];

export const TIMELINE_STACK_GROUPINGS: readonly {
  readonly label: string;
  readonly value: TimelineStackGrouping;
}[] = [
  { label: "Token Type", value: TimelineStackGrouping.TokenType },
  { label: "Model", value: TimelineStackGrouping.Model },
  { label: "Activity phase", value: TimelineStackGrouping.ActivityPhase },
  { label: "Session Owner", value: TimelineStackGrouping.Owner },
];

/**
 * The Group-by options a reader may choose from.
 *
 * ISS-5841: the "Activity phase" cut is withheld while activity phases are
 * gated off, so the control cannot offer to re-cut the chart by a phase model
 * the page no longer shows anywhere. The other three cuts are unaffected.
 */
export function visibleTimelineStackGroupings(
  activityPhasesEnabled: boolean
): readonly {
  readonly label: string;
  readonly value: TimelineStackGrouping;
}[] {
  if (activityPhasesEnabled) {
    return TIMELINE_STACK_GROUPINGS;
  }
  return TIMELINE_STACK_GROUPINGS.filter(
    (option) => option.value !== TimelineStackGrouping.ActivityPhase
  );
}

/**
 * The grouping actually used to cut the bars.
 *
 * The selection is in-memory (`useState`, not persisted), so a fresh mount
 * always starts on Token Type and cannot resurrect a phase cut from storage.
 * This guards the remaining case: a PostHog flag flipping OFF mid-session while
 * the phase cut is on screen, which would otherwise leave the chart stacked by
 * a dimension its own control no longer lists.
 *
 * Falls back to Token Type, the default. Every grouping sums to the same
 * per-column total, so this changes the cut and never the bar heights.
 */
export function resolveTimelineStackGrouping(
  grouping: TimelineStackGrouping,
  activityPhasesEnabled: boolean
): TimelineStackGrouping {
  if (
    !activityPhasesEnabled &&
    grouping === TimelineStackGrouping.ActivityPhase
  ) {
    return TimelineStackGrouping.TokenType;
  }
  return grouping;
}

export type TimelineStackSegment = {
  readonly colorVar: string;
  readonly key: string;
  readonly label: string;
  readonly value: number;
};

/**
 * Fallback name for the owner cut when the session outlived its owner record
 * (`session.user` is nullable and genuinely null on such rows). "Unknown owner"
 * rather than a blank swatch: an unlabelled segment reads as a rendering
 * failure, and this is a known, expected state.
 */
export const UNKNOWN_OWNER_LABEL = "Unknown owner";

const TOKEN_TYPE_SEGMENTS = [
  { colorVar: "var(--chart-3)", key: "cache", label: "Cache" },
  { colorVar: "var(--chart-2)", key: "output", label: "Output" },
  { colorVar: "var(--chart-1)", key: "input", label: "Input" },
] as const;

/** Stable fallback for a model with no assigned slot. */
const MODEL_FALLBACK_COLOR_VAR = "var(--chart-1)";
const MODEL_COLOR_SLOTS = 5;

export function getTimelineStackGroupingLabel(
  grouping: TimelineStackGrouping
): string {
  return (
    TIMELINE_STACK_GROUPINGS.find((option) => option.value === grouping)
      ?.label ?? "Group"
  );
}

/**
 * One colour per model for the whole strip, assigned by SORTED model name.
 *
 * Sorted, not first-seen: first-seen order depends on which columns happen to be
 * in the window, so panning the scrubber would repaint a model a different
 * colour mid-read.
 */
export function buildTimelineModelColors(
  buckets: readonly ActivityBucket[]
): ReadonlyMap<string, string> {
  const models = new Set<string>();
  for (const bucket of buckets) {
    for (const model of Object.keys(bucket.byModel)) {
      models.add(model);
    }
  }
  return new Map(
    [...models]
      .sort()
      .map((model, index) => [
        model,
        `var(--chart-${(index % MODEL_COLOR_SLOTS) + 1})`,
      ])
  );
}

/**
 * The stacked segments for every column, under one grouping.
 *
 * `phaseCosts` resolves to an array parallel to `buckets` (see
 * `session-timeline-projection`); a missing entry yields no phase segments
 * rather than a fabricated one.
 *
 * It is a THUNK, and this is the one place it is called (ISS-6054). The phase
 * split is expensive — a rescan of the session's classifier spans per column —
 * and only the Activity-phase cut renders it, so asking for it under any other
 * cut spends that work on a value the returned segments do not contain. Called
 * once here rather than per column, so the columns cannot disagree.
 */
export function buildTimelineStacks({
  buckets,
  grouping,
  modelColors,
  ownerLabel,
  phaseCosts,
}: {
  buckets: readonly ActivityBucket[];
  grouping: TimelineStackGrouping;
  modelColors: ReadonlyMap<string, string>;
  ownerLabel: string;
  phaseCosts: () => readonly Record<string, number>[];
}): TimelineStackSegment[][] {
  const resolvedPhaseCosts =
    grouping === TimelineStackGrouping.ActivityPhase
      ? phaseCosts()
      : NO_PHASE_COSTS;
  return buckets.map((bucket, index) =>
    buildColumnStack({
      bucket,
      grouping,
      modelColors,
      ownerLabel,
      phaseCost: resolvedPhaseCosts[index] ?? {},
    })
  );
}

function buildColumnStack({
  bucket,
  grouping,
  modelColors,
  ownerLabel,
  phaseCost,
}: {
  bucket: ActivityBucket;
  grouping: TimelineStackGrouping;
  modelColors: ReadonlyMap<string, string>;
  ownerLabel: string;
  phaseCost: Record<string, number>;
}): TimelineStackSegment[] {
  const cost = bucket.cIn + bucket.cOut + bucket.cCache;
  if (cost <= 0) {
    return [];
  }
  if (grouping === TimelineStackGrouping.TokenType) {
    return buildTokenTypeStack(bucket);
  }
  if (grouping === TimelineStackGrouping.Model) {
    return buildModelStack(bucket, modelColors);
  }
  if (grouping === TimelineStackGrouping.ActivityPhase) {
    return buildPhaseStack(phaseCost);
  }
  return [
    {
      colorVar: MODEL_FALLBACK_COLOR_VAR,
      key: "owner",
      label: ownerLabel,
      value: cost,
    },
  ];
}

function buildTokenTypeStack(bucket: ActivityBucket): TimelineStackSegment[] {
  const values: Record<string, number> = {
    cache: bucket.cCache,
    input: bucket.cIn,
    output: bucket.cOut,
  };
  return TOKEN_TYPE_SEGMENTS.map((segment) => ({
    ...segment,
    value: values[segment.key] ?? 0,
  })).filter((segment) => segment.value > 0);
}

function buildModelStack(
  bucket: ActivityBucket,
  modelColors: ReadonlyMap<string, string>
): TimelineStackSegment[] {
  return Object.entries(bucket.byModel)
    .map(([model, costs]) => ({
      colorVar: modelColors.get(model) ?? MODEL_FALLBACK_COLOR_VAR,
      key: model,
      label: model,
      value: costs.cIn + costs.cOut + costs.cCache,
    }))
    .filter((segment) => segment.value > 0)
    .sort((left, right) => left.key.localeCompare(right.key));
}

function buildPhaseStack(
  phaseCost: Record<string, number>
): TimelineStackSegment[] {
  return Object.entries(phaseCost)
    .filter(([, value]) => value > 0)
    .map(([phase, value]) => {
      const display = getPhaseDisplay(phase);
      return {
        colorVar: display.colorVar,
        key: phase,
        label: display.label,
        value,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

/** Stands in for the phase split under the cuts that never read it. */
const NO_PHASE_COSTS: readonly Record<string, number>[] = [];
