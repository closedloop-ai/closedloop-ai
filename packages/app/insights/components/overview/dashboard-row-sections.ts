import type {
  AgentPipelineGraphData,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { InsightsSection as InsightsSectionValues } from "@repo/api/src/types/insights";
import type { DashboardRow, DashboardRowTour } from "./dashboard-tiles";

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
 */
export function isRowLoading(
  row: DashboardRow,
  sectionLoading: Record<InsightsSection, boolean>
): boolean {
  const deps = ROW_SECTIONS[row.tour];
  return deps.some((section) => sectionLoading[section]);
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
 * even with the gate open. Treat it exactly like its absent-data rowmates
 * (activity / autonomy / frustration): keep the row while the Agents section is
 * still loading so the layout does not reflow, and drop it once that section
 * resolves without nodes.
 *
 * Shared by the web (`InsightsOverviewDashboard`) and desktop
 * (`first-launch-dashboard`) shells so the two surfaces cannot drift on when
 * the row disappears — the same reason `ROW_SECTIONS` lives here (FEA-4020).
 */
export function hasAgentPipelineNodes(
  agentPipeline: AgentPipelineGraphData | undefined
): boolean {
  return (agentPipeline?.nodes.length ?? 0) > 0;
}
