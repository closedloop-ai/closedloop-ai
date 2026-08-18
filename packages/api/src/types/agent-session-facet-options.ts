/**
 * Option shapes for the Sessions filter facets that are DERIVED from usage
 * aggregates rather than from a fixed contract (Status, Autonomy, Cost).
 *
 * Split out of `agent-session.ts` (ISS-5355) because a facet option is not a
 * usage breakdown: a breakdown is a cost/token lens over a population, while an
 * option is "a value you can select, and how many sessions carry it". Keeping
 * them apart is what stops a facet option being modelled as a breakdown with
 * fabricated zeros in the token fields it cannot actually measure. Also shrinks
 * `agent-session.ts`, which is grandfathered over the 1,000-line ceiling and is
 * SHRINK-ONLY (AGENTS.md → "File Size and Organization").
 */

/**
 * FEA-4303: an option for the Sessions Model filter facet, keyed by the PRIMARY
 * displayed model (`SessionDetail.model`) — the exact string painted in the
 * table's Model column. Distinct from `AgentSessionUsageByModel` (a cost lens
 * over EVERY model a session used, including secondary/subagent models): the
 * filter and the column must share one vocabulary so selecting an option only
 * returns rows whose visible Model equals the selection.
 */
export type AgentSessionModelFacetOption = {
  model: string;
  sessionCount: number;
};

/**
 * ISS-5355: an option for the Sessions Project filter facet. Deliberately NOT
 * `AgentSessionProjectBreakdown`: the facet count is grouped on
 * `Artifact.projectId`, and the artifact row carries no token or cost columns,
 * so this shape declares only what that aggregate can actually measure rather
 * than padding the breakdown's token fields with a fabricated `0`. Mirrors
 * {@link AgentSessionModelFacetOption}, the same
 * facet-option-is-not-a-breakdown split FEA-4303 made for Model.
 */
export type AgentSessionProjectFacetOption = {
  projectId: string;
  projectName: string;
  sessionCount: number;
};
