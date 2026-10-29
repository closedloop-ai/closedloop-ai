"use client";

import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import {
  type DotColor,
  getDotLabel,
  getDotSemantic,
} from "@repo/app/agents/components/detail/activity-dot-rendering";
import type { DotCell } from "@repo/app/agents/components/detail/session-timeline-dot-cells";
import {
  buildTimelineTokenTypeStacks,
  type TimelineStackSegment,
} from "@repo/app/agents/lib/session-timeline-stacks";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { SESSION_TIMELINE_LEGEND_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { getTimelineMarkerSemanticSort } from "@repo/app/shared/lib/timeline-marker-semantics";
import { SessionTimelineMarkSwatch } from "./session-timeline-mark-swatch";

/**
 * ISS-10598: the strip's bar colours and dot colours both meant something —
 * which token type or model a bar segment was, which of three event kinds a
 * dot was — with nothing on screen saying so. A reader had to already know
 * the codebase, or guess.
 *
 * Both keys below are read from the SAME sources the strip itself paints
 * from, not a second hand-typed copy that could drift out of sync:
 * - The bar key derives from `stacks` (`buildTimelineStacks`'s own output,
 *   the exact segments `SessionTimelineBars` renders), deduped by `key`,
 *   falling back to {@link buildTimelineTokenTypeStacks} over the same
 *   buckets on the one branch that paints bars without stacks — see
 *   {@link resolveBarEntries}.
 * - The dot key derives from the rail's own lanes, ordered by
 *   `TIMELINE_MARKER_SEMANTIC_ORDER`, and draws each swatch with
 *   `SessionTimelineMarkSwatch` — `getDotLabel`, `getDotColorToken` and
 *   `getDotShapeClassName`, the same functions the dot's own tooltip,
 *   accessible name and mark use (ISS-12117: each lane's shape, square,
 *   circle or diamond, is in the key too) —
 *   so this key is a second SURFACE for that data, not a second SOURCE of it.
 *
 * NEITHER KEY NAMES A COLOUR THE STRIP IS NOT WEARING, and both are filtered
 * by the same test the renderer uses (tamsinb, #7602): a bar segment appears
 * only where `buildTimelineStacks`'s own `value > 0` filter kept it, and a dot
 * kind appears only where some cell's lane is non-empty, which is exactly
 * `SessionTimelineDotRail`'s `cell[color].length > 0`. A session that never
 * failed gets no failure row, the same way one that never spent on cache gets
 * no cache row. With both keys empty the component renders nothing.
 *
 * SCOPE IS THE VISIBLE WINDOW, NOT THE SESSION (marisolashgrove, #7602). `stacks`
 * is built from `projection.buckets`, which `projectSessionTimeline` cuts to
 * the scrubber's current window (`TIMELINE_VISIBLE_COLUMNS`), so under "Model"
 * grouping this key names the models on screen RIGHT NOW and gains and loses
 * rows as the reader pans. That is deliberate: the key exists to explain the
 * bars the reader is looking at, and a row for a model whose every segment is
 * off-screen would point at nothing. It also means the swatches can be a
 * non-contiguous set of `--chart-N` slots, because `buildTimelineModelColors`
 * assigns colours from the WHOLE bucket set precisely so a model's colour does
 * not move on a pan (`use-session-timeline-scale.ts`).
 *
 * Kept as two visually separate groups rather than one merged list: bar
 * colour answers "what kind of work", dot colour answers "what kind of
 * event" — a single mixed key would imply a relationship between e.g.
 * "Cache" and "Commits & PRs" that does not exist. Each group is a `<dl>`
 * with its name in the `<dt>`, so the grouping the visual design makes
 * survives into the accessibility tree instead of flattening to one run of
 * words (marisolashgrove, #7602). The name is stated ONCE, in that `<dt>`: the
 * swatch is `aria-hidden` because the adjacent word is the statement of what
 * the colour means (WCAG 1.4.1 — never hue alone).
 *
 * Gated CLOSED on {@link SESSION_TIMELINE_LEGEND_FEATURE_FLAG_KEY}, the
 * ISS-4779 closed-by-default policy for perceivable UI. Read HERE, at the one
 * place that swaps on it, rather than threaded in from the strip.
 */
export function SessionTimelineLegend({
  buckets,
  cells,
  costUnmeasured,
  stacks,
}: Readonly<{
  /**
   * The columns `SessionTimelineBars` is rendering. Read ONLY on the
   * `stacks == null` fallback, where they are the sole record of which token
   * types this strip actually spent on.
   */
  buckets: readonly ActivityBucket[];
  /** The dot rail's own lanes — the same array it decides each dot from. */
  cells: readonly DotCell[];
  /**
   * `true` when this strip's per-bucket money was synthesized, the state in
   * which `renderBarStack` (`session-timeline-bars.tsx`) returns NO stack at
   * all rather than re-cutting an invented split. The absent operand is the
   * painted segments themselves: with no coloured bar on screen, a bar key
   * would be naming colours that are not there (whitlockk, #7602). The dot key is
   * untouched — dots are events, not money, and they still render.
   */
  costUnmeasured: boolean;
  stacks: readonly (readonly TimelineStackSegment[])[] | null;
}>) {
  const legendEnabled = useFeatureFlagEnabledOptional(
    SESSION_TIMELINE_LEGEND_FEATURE_FLAG_KEY
  );
  if (!legendEnabled) {
    return null;
  }

  const barEntries = costUnmeasured ? [] : resolveBarEntries(stacks, buckets);
  const dotEntries = resolveDotEntries(cells);

  if (barEntries.length === 0 && dotEntries.length === 0) {
    return null;
  }

  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-8 gap-y-1">
      {barEntries.length === 0 ? null : (
        <LegendGroup
          entries={barEntries}
          label={SESSION_TIMELINE_LEGEND_BARS_LABEL}
        />
      )}
      {dotEntries.length === 0 ? null : (
        <LegendGroup
          entries={dotEntries}
          label={SESSION_TIMELINE_LEGEND_DOTS_LABEL}
        />
      )}
    </div>
  );
}

/**
 * The dot kinds this strip actually PLOTTED, in the canonical order.
 *
 * `SessionTimelineDotRail` renders a dot only where `cell[color].length > 0`,
 * so listing the whole three-word vocabulary named colours a reader could not
 * find (tamsinb, #7602). Ordered by `TIMELINE_MARKER_SEMANTIC_ORDER` rather
 * than by first appearance, so panning cannot reorder the key.
 */
function resolveDotEntries(cells: readonly DotCell[]): LegendEntry[] {
  return DOT_LANE_COLORS.filter((color) =>
    cells.some((cell) => cell[color].length > 0)
  )
    .sort(
      (left, right) =>
        getTimelineMarkerSemanticSort(getDotSemantic(left)) -
        getTimelineMarkerSemanticSort(getDotSemantic(right))
    )
    .map((color) => ({
      dotColor: color,
      key: getDotSemantic(color),
      label: getDotLabel(color),
    }));
}

/**
 * A bar row carries the segment's `colorVar`; a dot row carries its lane, so
 * its swatch is drawn by `SessionTimelineMarkSwatch` in the mark's own shape.
 */
type LegendEntry = {
  readonly key: string;
  readonly label: string;
} & (
  | { readonly colorVar: string; readonly dotColor?: never }
  | { readonly colorVar?: never; readonly dotColor: DotColor }
);

function LegendGroup({
  entries,
  label,
}: Readonly<{
  entries: readonly LegendEntry[];
  label: string;
}>) {
  return (
    <dl className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <dt className="whitespace-nowrap text-muted-foreground text-xs">
        {label}
      </dt>
      {entries.map((entry) => (
        <dd
          className="m-0 flex items-center gap-1.5 whitespace-nowrap text-muted-foreground text-xs"
          key={entry.key}
        >
          {entry.dotColor === undefined ? (
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.colorVar }}
            />
          ) : (
            <SessionTimelineMarkSwatch
              className="size-2 shrink-0"
              color={entry.dotColor}
            />
          )}
          {entry.label}
        </dd>
      ))}
    </dl>
  );
}

/**
 * The bar key for whatever `SessionTimelineBars` is actually painting.
 *
 * `stacks == null` is NOT "no bars" — it is the ordinal fallback
 * (`useSessionTimelineScale` returns `stacks: null` when no projection
 * resolves), where `renderBarStack` still paints the legacy
 * `.cb-cache`/`.cb-out`/`.cb-in` elements from the token-type palette. Left to
 * the dot key alone, those bars would be the one coloured thing on the strip
 * with nothing explaining them (whitlockk, #7602), so this branch builds the same
 * per-column, `value > 0`-filtered token-type stacks over the buckets the
 * strip is rendering and hands them to the SAME union below. Deriving them
 * rather than printing the three constants unconditionally is what keeps a
 * session that never spent on cache from getting a Cache row, and what leaves
 * the key empty when every bucket is cost 0 and `renderBarStack` paints
 * nothing at all (tamsinb, #7602).
 */
function resolveBarEntries(
  stacks: readonly (readonly TimelineStackSegment[])[] | null,
  buckets: readonly ActivityBucket[]
): LegendEntry[] {
  return dedupeBarSegments(stacks ?? buildTimelineTokenTypeStacks(buckets));
}

/**
 * `stacks` is one segment array PER COLUMN OF THE VISIBLE WINDOW, and
 * `buildTimelineStacks` filters every column to only the segments with a
 * positive value for THAT column (see `buildTokenTypeStack`/`buildModelStack`'s
 * own `.filter((segment) => segment.value > 0)`) — a column with cache activity
 * but no output that hour omits the output segment entirely. A key derived from
 * any single column can silently miss a token type or model that is real in the
 * column beside it, so this unions every column it was handed, keyed by `key`
 * (stable per type/model — a segment's `colorVar`/`label` never varies by column
 * under `buildTimelineStacks`'s own invariant, only `value` does, so the first
 * occurrence of a `key` is a safe representative for all of them). The union is
 * over the WINDOW, not the session, because that is what it was handed and what
 * is on screen — see the component docstring. Sorted by label for a stable,
 * boring, alphabetical key rather than whatever order the columns happened to
 * introduce each one in.
 */
function dedupeBarSegments(
  stacks: readonly (readonly TimelineStackSegment[])[]
): LegendEntry[] {
  const byKey = new Map<string, LegendEntry>();
  for (const column of stacks) {
    for (const segment of column) {
      if (!byKey.has(segment.key)) {
        byKey.set(segment.key, {
          colorVar: segment.colorVar,
          key: segment.key,
          label: segment.label,
        });
      }
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.label.localeCompare(right.label)
  );
}

/**
 * The two group names, exported so a test can LOCATE a group through the same
 * constant the component renders rather than re-typing the words — a literal
 * only an absence assertion holds matches nothing once the copy is reworded,
 * and the regression it exists to catch passes.
 */
export const SESSION_TIMELINE_LEGEND_BARS_LABEL = "Bars";
export const SESSION_TIMELINE_LEGEND_DOTS_LABEL = "Dots";

/** The dot rail's three lanes, the keys it indexes each cell by. */
const DOT_LANE_COLORS: readonly DotColor[] = ["b", "g", "r"];
