import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import type { BasicUser } from "@repo/api/src/types/user";
import { getUserDisplayName } from "../../shared/lib/user-utils";
import { resolveSessionOwner, type SessionOwnerSubject } from "./session-owner";

/**
 * ISS-5819 — the Session Timeline's "Group by" dimensions.
 *
 * The strip has always stacked each bar one way: input / output / cache. That is
 * one true answer to "where did the money go", and it is not the only question a
 * reader has — "which MODEL cost that", "whose session" are the same bar re-cut
 * along a different axis. This module owns all three cuts so a bar and its own
 * hover card cannot disagree about which one is showing.
 *
 * Every grouping sums to the SAME per-column total. That is the invariant worth
 * protecting: re-cutting a bar must never change how tall it is, or the control
 * would look like it was changing the data rather than the view of it.
 */

export const TimelineStackGrouping = {
  TokenType: "token-type",
  Model: "model",
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
  { label: "Session Owner", value: TimelineStackGrouping.Owner },
];

export type TimelineStackSegment = {
  readonly colorVar: string;
  readonly key: string;
  readonly label: string;
  readonly value: number;
};

/**
 * Fallback name for the owner cut when the session has no Owner (its assignee
 * is null: never assigned, or the person was deleted). "Unknown owner" rather
 * than a blank swatch: an unlabelled segment reads as a rendering failure, and
 * this is a known, expected state.
 */
export const UNKNOWN_OWNER_LABEL = "Unknown owner";

/**
 * Fallback name for the model cut when the record cannot name one model for a
 * slice — a session whose model never resolved, or one that ran several and so
 * has no basis for handing the whole slice to any of them (ISS-5634).
 *
 * Same reasoning as {@link UNKNOWN_OWNER_LABEL}, and it is a `byModel` KEY as
 * well as a label, because that record is what both the model cut and the hover
 * card's model column read. Naming the state beats the two alternatives: a
 * placeholder word reads as a real model name, and an absent entry leaves the
 * bar's interior unpainted under this cut, which reads as a rendering failure.
 */
export const UNKNOWN_MODEL_LABEL = "Unknown model";

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

/** The stacked segments for every column, under one grouping. */
export function buildTimelineStacks({
  buckets,
  grouping,
  modelColors,
  ownerLabel,
}: {
  buckets: readonly ActivityBucket[];
  grouping: TimelineStackGrouping;
  modelColors: ReadonlyMap<string, string>;
  ownerLabel: string;
}): TimelineStackSegment[][] {
  return buckets.map((bucket) =>
    buildColumnStack({
      bucket,
      grouping,
      modelColors,
      ownerLabel,
    })
  );
}

function buildColumnStack({
  bucket,
  grouping,
  modelColors,
  ownerLabel,
}: {
  bucket: ActivityBucket;
  grouping: TimelineStackGrouping;
  modelColors: ReadonlyMap<string, string>;
  ownerLabel: string;
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

/**
 * The token-type cut, built for columns `buildTimelineStacks` never sees.
 *
 * `useSessionTimelineScale` returns `stacks: null` on its `projection == null`
 * branch, and `renderBarStack` then paints the legacy `.cb-cache`/`.cb-out`/
 * `.cb-in` elements — which `packages/app/styles.css` colours from the SAME
 * `--chart-3`/`--chart-2`/`--chart-1` tokens {@link TOKEN_TYPE_SEGMENTS}
 * carries. A key for those bars therefore has to be per-column and filtered
 * exactly as {@link buildTimelineStacks} is, or it names a token type the
 * session never spent on: the `cost <= 0` guard and the per-segment
 * `value > 0` filter below are {@link buildColumnStack}'s own, not a second
 * approximation of them (tamsinb, #7602).
 */
export function buildTimelineTokenTypeStacks(
  buckets: readonly ActivityBucket[]
): TimelineStackSegment[][] {
  return buckets.map((bucket) => {
    const cost = bucket.cIn + bucket.cOut + bucket.cCache;
    if (cost <= 0) {
      return [];
    }
    return buildTokenTypeStack(bucket);
  });
}

/** The "Session Owner" cut's one label: the session's Owner (ISS-12251 D-1). */
export function resolveTimelineOwnerLabel(
  session: SessionOwnerSubject<BasicUser>
): string {
  const owner = resolveSessionOwner(session);
  return owner ? getUserDisplayName(owner) : UNKNOWN_OWNER_LABEL;
}
