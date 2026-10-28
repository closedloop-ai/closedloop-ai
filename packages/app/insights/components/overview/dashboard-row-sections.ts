import type {
  AgentPipelineGraphData,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { InsightsSection as InsightsSectionValues } from "@repo/api/src/types/insights";
import type { InsightsSectionData } from "../tile-content";
import {
  type DashboardRow,
  type DashboardRowGates,
  DashboardRowTour,
  dashboardRowsFor,
} from "./dashboard-tiles";

// Which insights sections each dashboard row reads from, keyed by the row's
// `tour` anchor (the stable row identity). Shared by the web
// (`InsightsOverviewDashboard`) and desktop (`first-launch-dashboard`) shells so
// the row→section dependency map — and therefore the per-row loading gating —
// cannot drift between the two surfaces (FEA-4020). Typed as an exhaustive
// `Record<DashboardRowTour, …>` so a newly added row fails typecheck until it
// declares its section dependencies, rather than silently skipping its skeleton.
export const ROW_SECTIONS: Record<
  DashboardRowTour,
  readonly InsightsSection[]
> = {
  // Headline KPIs pull sessions from Utilization and PRs/KLOC/cost from Delivery.
  stats: [InsightsSectionValues.Delivery, InsightsSectionValues.Utilization],
  activity: [InsightsSectionValues.Utilization],
  models: [InsightsSectionValues.Agents],
  "agent-pipeline": [InsightsSectionValues.Agents],
  autonomy: [InsightsSectionValues.Agents],
  frustration: [InsightsSectionValues.Agents],
  prs: [InsightsSectionValues.Delivery],
  distribution: [InsightsSectionValues.Delivery, InsightsSectionValues.Agents],
};

/**
 * A row is loading (draws its skeleton) while any section it reads from is on
 * its first load — neither settled-success nor errored.
 *
 * UNRECOGNISED KEYS RESOLVE TO LOADING, NOT TO LOADED (ISS-6673). Both lookups
 * here can miss at runtime even though the types say otherwise, and the two
 * misses used to fail in opposite, equally wrong ways:
 *
 *   - A `row.tour` absent from {@link ROW_SECTIONS} produced `undefined` and
 *     `undefined.some(…)` threw, taking down the WHOLE dashboard render rather
 *     than the one row that was unrecognised.
 *   - A declared section absent from `sectionLoading` read as `undefined`,
 *     which is falsy, so the row was reported LOADED and rendered its content
 *     against data that had not arrived — a still-loading section presented as
 *     a settled zero, which is the one thing a loading state must never be
 *     indistinguishable from.
 *
 * "We do not recognise this key" and "we know this section has settled" are
 * different facts, so they must not produce the same answer.
 *
 * THIS IS A BACKSTOP, NOT A LIVE PATH. Every call site in this repo passes
 * locally-derived values — `row.tour` comes from the module const
 * `DASHBOARD_ROWS`, and `sectionLoading` is built inline from three exhaustive
 * react-query flags — so neither branch below is reachable today, and the
 * rendered output for every input the dashboard actually produces is unchanged.
 * The branches exist because `Record<…>` is a compile-time claim over data that
 * a future caller could source from the cloud API or the desktop IPC boundary,
 * where it stops being enforced. ISS-6673 asks that an unrecognised key be
 * SURFACED rather than silently dropped, which is why the row is kept.
 *
 * KNOWN RESIDUAL: because the return is a boolean, "unknown" can only be spelled
 * as "loading", and the sole consumer renders that as a skeleton. A row that
 * reached this state would therefore skeleton indefinitely — better than the
 * TypeError and better than a false zero, but still not a state a reader can
 * act on. Distinguishing it properly needs a third value and a row-level
 * degraded rendering, which is a UI decision rather than a defect fix. The
 * `ROW_SECTIONS`-vs-`DASHBOARD_ROWS` totality test is what stops a real row
 * getting there.
 */
export function isRowLoading(
  row: DashboardRow,
  sectionLoading: Record<InsightsSection, boolean>
): boolean {
  const deps = ROW_SECTIONS[row.tour];
  if (!deps) {
    return true;
  }
  return deps.some((section) => sectionLoading[section] !== false);
}

/**
 * Whether the Agent Collaboration Network row has anything to draw.
 *
 * A SECOND, independent reason this row can be absent — it sits ON TOP of the
 * closed-by-default gate, it does not replace it. ISS-5061 (re-introduced after
 * ISS-5280/#4482 retired it) decides whether the row EXISTS at all; this decides
 * whether an existing row has anything to draw. The row is a 340px card with its
 * own section header, and `AgentPipelineGraph` draws its own empty-state — so an
 * org that runs no subagents would carry a permanent empty card on the overview
 * even with the gate open.
 */
function hasAgentPipelineNodes(
  agentPipeline: AgentPipelineGraphData | undefined
): boolean {
  return (agentPipeline?.nodes.length ?? 0) > 0;
}

/**
 * The dashboard rows to render, in order. The ONE place either shell decides
 * which rows exist (ISS-9993): the closed-by-default gates first
 * ({@link dashboardRowsFor}), then the data-shape rule in
 * {@link ROW_HAS_DATA}. Both hosts call this and filter nothing themselves, so
 * a new data-conditional row reaches both of them or neither.
 *
 * A row with a data check is kept while a section it reads from is still
 * loading, so the layout does not reflow when the data lands, and dropped once
 * those sections settle without its data. The alternative is a permanent empty
 * card, or a skeleton that never resolves.
 */
export function visibleDashboardRows({
  gates,
  sections,
  sectionLoading,
  sectionFailed,
}: {
  gates: DashboardRowGates;
  sections: InsightsSectionData;
  sectionLoading: Record<InsightsSection, boolean>;
  /**
   * Optional so a shell that still refuses the whole page on any failed section
   * is unaffected; absent, a failed section reads as loading exactly as before.
   */
  sectionFailed?: Record<InsightsSection, boolean>;
}): DashboardRow[] {
  return dashboardRowsFor(gates).filter((row) => {
    const hasData = ROW_HAS_DATA[row.tour];
    if (!hasData || hasData(sections)) {
      return true;
    }
    // A row that exists only when its data arrives was never established to
    // exist, and a failed read cannot establish it. Drawing a degraded card for
    // it would claim a section is missing that this surface may never serve —
    // the cloud route omits `autonomyTrend` on every response (ISS-10486
    // review). Asked BEFORE the loading check, which reads a failed section as
    // pending and would otherwise keep the row forever.
    if (sectionFailed && isRowFailed(row, sectionFailed)) {
      return false;
    }
    return isRowLoading(row, sectionLoading);
  });
}

/**
 * The row Recent Sessions renders under: the activity heatmap when that row is
 * shown, the headline stats row when it is not. Read off the visible rows, so
 * the card is never anchored to a dropped row, which would drop the card with
 * it. The activity row is kept while Utilization loads, so the card does not
 * move when the heatmap lands.
 */
export function recentSessionsAnchorRow(
  rows: readonly DashboardRow[]
): DashboardRowTour {
  return rows.some((row) => row.tour === DashboardRowTour.Activity)
    ? DashboardRowTour.Activity
    : DashboardRowTour.Stats;
}

type RowDataCheck = (sections: InsightsSectionData) => boolean;

/**
 * Which rows can be absent for lack of data, and how to tell. `null` marks a row
 * that always renders once its sections land. Exhaustive over
 * `DashboardRowTour`, so a new row fails typecheck until it declares which kind
 * it is.
 */
const ROW_HAS_DATA: Record<DashboardRowTour, RowDataCheck | null> = {
  stats: null,
  // FEA-3684 moved the heatmap into the cloud route, but an older route, or a
  // desktop with no local turn buckets to fall back on, still returns none.
  activity: (sections) =>
    Boolean(
      sections[InsightsSectionValues.Utilization]?.charts.activityHeatmap
    ),
  models: null,
  "agent-pipeline": (sections) =>
    hasAgentPipelineNodes(
      sections[InsightsSectionValues.Agents]?.charts.agentPipeline
    ),
  // Only the desktop's local engine produces it; the cloud route omits it.
  autonomy: (sections) =>
    Boolean(sections[InsightsSectionValues.Agents]?.charts.autonomyTrend),
  // FEA-4022: org opt-in, and absent when no session has been scored.
  frustration: (sections) =>
    Boolean(sections[InsightsSectionValues.Agents]?.charts.frustrationTrend),
  prs: null,
  distribution: null,
};

/**
 * Whether a row can never resolve, because a section it reads from reached a
 * terminal error.
 *
 * MUST BE ASKED BEFORE {@link isRowLoading}, not instead of it. `sectionLoading`
 * is built as `!isSuccess`, so an errored section is indistinguishable from a
 * pending one there — a caller that skips this check draws that row's skeleton
 * forever. Splitting the two facts apart is what lets a shell stop replacing the
 * whole dashboard when one of three sections fails: the rows that read from the
 * failed section degrade, and the rest keep their data. The web shell does that
 * today (ISS-10486); ISS-10408 is landing the same split on desktop, which still
 * refuses the whole page on any errored section.
 *
 * An unrecognised `row.tour` is NOT reported as failed — it falls through to
 * `isRowLoading`, which owns the ISS-6673 unknown-key backstop. "We do not
 * recognise this row" is not "this row's data failed", and only one of those
 * two answers may be invented here.
 */
export function isRowFailed(
  row: DashboardRow,
  sectionFailed: Record<InsightsSection, boolean>
): boolean {
  const deps = ROW_SECTIONS[row.tour];
  if (!deps) {
    return false;
  }
  return deps.some((section) => sectionFailed[section] === true);
}

/**
 * What a dashboard row draws, as one closed value.
 *
 * `Failed` outranks `Loading` and that precedence lives HERE rather than in
 * each shell, because asking the two questions in the wrong order is silent:
 * `sectionLoading` is built as `!isSuccess`, so a terminally errored section
 * reads as pending there, and a caller that checked loading first would
 * skeleton that row for the life of the window.
 */
export const DashboardRowState = {
  Failed: "failed",
  Loading: "loading",
  Ready: "ready",
} as const;
export type DashboardRowState =
  (typeof DashboardRowState)[keyof typeof DashboardRowState];

/**
 * The one derivation of a row's state, so a shell that also needs the answer for
 * an adjacent element cannot recombine the inputs into a second, divergent one.
 */
export function resolveDashboardRowState(
  row: DashboardRow,
  sectionLoading: Record<InsightsSection, boolean>,
  sectionFailed: Record<InsightsSection, boolean>
): DashboardRowState {
  const deps = ROW_SECTIONS[row.tour];
  if (!deps) {
    // The ISS-6673 backstop: an unrecognised row is loading, never failed.
    return DashboardRowState.Loading;
  }
  return resolveInsightsSectionsState(deps, sectionLoading, sectionFailed);
}

/**
 * The same verdict over an explicit section list, for an element that is not a
 * row and therefore has no `ROW_SECTIONS` entry — the AI-impact card, which sits
 * under the stats row and reads a different set than that row does.
 *
 * The precedence lives HERE and {@link resolveDashboardRowState} delegates to
 * it, so the two callers cannot disagree about whether failed outranks loading.
 */
export function resolveInsightsSectionsState(
  deps: readonly InsightsSection[],
  sectionLoading: Record<InsightsSection, boolean>,
  sectionFailed: Record<InsightsSection, boolean>
): DashboardRowState {
  if (deps.some((section) => sectionFailed[section] === true)) {
    return DashboardRowState.Failed;
  }
  if (deps.some((section) => sectionLoading[section] !== false)) {
    return DashboardRowState.Loading;
  }
  return DashboardRowState.Ready;
}

/**
 * Whether a refetch is in flight for the sections this element reads from.
 *
 * The busy half of the scoped recovery in {@link useInsightsSectionRetry}, and
 * it has to be scoped for the same reason the invalidation does: read off all
 * three queries, one row's Retry reports every degraded row as retrying and
 * disables their buttons, so a reader pressing Agents is told Delivery is
 * recovering too. Kept beside {@link resolveInsightsSectionsState} because it
 * takes the same `ROW_SECTIONS` list from the same lookup, so a row's busy
 * answer and its state answer cannot be derived from different section sets.
 *
 * NO EXPLICIT-LIST SIBLING, unlike {@link resolveInsightsSectionsState}, which
 * has one because the AI-impact card resolves its own state. That card has no
 * Retry control, so nothing off-row ever asks this question and an exported
 * `anySectionFetching` sat with no consumer outside this file (ISS-10486
 * review). Give the card recovery and the extraction comes back with a caller.
 *
 * An unrecognised `row.tour` is NOT reported as fetching — the same split
 * {@link isRowFailed} makes. Such a row is Loading (ISS-6673), never Failed, so
 * it draws a skeleton and has no Retry control for this answer to reach.
 */
export function isRowRetrying(
  row: DashboardRow,
  sectionFetching: Record<InsightsSection, boolean>
): boolean {
  const deps = ROW_SECTIONS[row.tour];
  if (!deps) {
    return false;
  }
  return deps.some((section) => sectionFetching[section] === true);
}

/**
 * ISS-10414: whether a row is drawing the PREVIOUS range/scope's payload.
 *
 * The sibling of {@link isRowLoading} over the same {@link ROW_SECTIONS} map,
 * and deliberately a SEPARATE fact from it: a section serving `keepPreviousData`
 * reports settled success, so `isRowLoading` is false and the row renders — with
 * last window's numbers under this window's label. Loading says "there is
 * nothing to draw yet"; this says "what is drawn is not what you selected".
 *
 * UNRECOGNISED KEYS RESOLVE TO CURRENT, which is the OPPOSITE of
 * `isRowLoading`'s unknown-is-loading fold — deliberately, because the harm is
 * not symmetric here. Unknown-is-loading WITHHOLDS a value that might be wrong.
 * Unknown-is-stale would assert an update that may not be happening AND
 * withdraw the period caption that is, on that input, still true — inventing a
 * claim out of a missing one, which is the defect class this ticket is in, not
 * a defense against it. Resolving unknown to current is the shipped behavior
 * (no disclosure at all), so a missing key degrades to today rather than to a
 * new lie.
 *
 * Like its sibling this is a BACKSTOP: both hosts build `sectionStale` inline
 * from three exhaustive react-query flags and `row.tour` comes from the module
 * const `DASHBOARD_ROWS`, so neither miss is reachable, and the
 * `ROW_SECTIONS`-vs-`DASHBOARD_ROWS` totality test is what keeps a real row out
 * of it.
 */
export function isRowStale(
  row: DashboardRow,
  sectionStale: Record<InsightsSection, boolean>
): boolean {
  const deps = ROW_SECTIONS[row.tour];
  if (!deps) {
    return false;
  }
  return deps.some((section) => sectionStale[section] === true);
}
