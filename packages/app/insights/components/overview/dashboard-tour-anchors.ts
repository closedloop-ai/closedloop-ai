import type { DashboardRowTour } from "./dashboard-tiles";

/**
 * The closed set of `data-tour` anchor keys the overview Dashboard emits, shared
 * by the web shell (`InsightsOverviewDashboard`) and the desktop shell
 * (`first-launch-dashboard`).
 *
 * The guided tour resolves a step with
 * `document.querySelector('[data-tour="<key>"]')`, so an anchor that only one
 * shell emits — or a step naming a key nothing emits — drops that step silently
 * at runtime with no type error and no failing render. Both shells emit through
 * this const so the anchor vocabulary is one list rather than two sets of
 * hand-written literals that have already drifted once (ISS-8351: desktop
 * carried a `sessions` anchor the web shell never emitted).
 *
 * Most anchors are dashboard ROWS. Their literals are written out rather than
 * spread from {@link DashboardRowTour}, deliberately: spreading would make this
 * module import `dashboard-tiles` at RUNTIME, which drags the tile catalog into
 * every consumer's bundle and breaks any suite that partially mocks
 * `dashboard-tiles` without also stubbing the const. The values still cannot
 * drift — {@link ROW_TOUR_ANCHORS} is typed to the identity, so a row anchor
 * whose string stops matching its row key fails typecheck there.
 *
 * `Impact` and `Sessions` are the two cards that render BETWEEN rows and so have
 * no row identity of their own; `Sessions` in particular must NOT be anchored on
 * a row, because the row it renders under is resolved at runtime (`activity` or
 * `stats`, depending on whether the heatmap exists) while the card is stable.
 *
 * `GettingStarted` is the odd one out and deliberately so: it is the only anchor
 * that exists when NO row does. The empty branch replaces the whole body, so on
 * a zero-session org it is the single measurable thing on the page, and the
 * reduced run in `dashboard-tour-steps.ts` is the only run that names it. It is
 * therefore mutually exclusive with every anchor above rather than an addition
 * to them — a page emitting this one has drawn no rows at all.
 */
export const DashboardTourAnchor = {
  Stats: "stats",
  Impact: "impact",
  Activity: "activity",
  Sessions: "sessions",
  Models: "models",
  AgentPipeline: "agent-pipeline",
  Autonomy: "autonomy",
  Frustration: "frustration",
  Prs: "prs",
  Distribution: "distribution",
  GettingStarted: "getting-started",
} as const;
export type DashboardTourAnchor =
  (typeof DashboardTourAnchor)[keyof typeof DashboardTourAnchor];

/**
 * Each dashboard row's anchor, keyed by the row's `tour` identity. Both shells
 * emit their per-row `data-tour` through this map.
 *
 * Typed `{ [Row in DashboardRowTour]: Row }` — exhaustive like `ROW_SECTIONS`
 * (`dashboard-row-sections.ts`), so a newly added row fails typecheck until it
 * declares an anchor, AND pinned to the identity, so the anchor it declares can
 * only be its own. A `Record<DashboardRowTour, DashboardTourAnchor>` gives the
 * first half and not the second: `newRow: DashboardTourAnchor.Prs` would
 * compile, emit a second `[data-tour="prs"]` element, and leave the new row
 * unreachable to `querySelector`, which returns whichever comes first in
 * document order. A `string[]` or `ReadonlySet<string>` gives neither half.
 */
export const ROW_TOUR_ANCHORS: { [Row in DashboardRowTour]: Row } = {
  stats: DashboardTourAnchor.Stats,
  activity: DashboardTourAnchor.Activity,
  models: DashboardTourAnchor.Models,
  "agent-pipeline": DashboardTourAnchor.AgentPipeline,
  autonomy: DashboardTourAnchor.Autonomy,
  frustration: DashboardTourAnchor.Frustration,
  prs: DashboardTourAnchor.Prs,
  distribution: DashboardTourAnchor.Distribution,
};
