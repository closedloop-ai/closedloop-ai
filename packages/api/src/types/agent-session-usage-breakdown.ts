// The per-dimension breakdown rows the Sessions usage and analytics reads emit.
//
// Split out of `agent-session.ts` while it was over the 1,000-line ceiling
// (AGENTS.md → "File Size and Organization": a grandfathered file must leave every
// change smaller than it found it). These six shapes are one responsibility — a
// population counted along ONE dimension — and are consumed as a set by the
// analytics aggregators, the facet projections and the breakdown tables, so they
// travel together rather than sitting inside the omnibus session contract.
//
// Every row is a COUNT OVER A COHORT, never a per-session record: each carries the
// key it is grouped by plus the totals for that group. Token and cost fields are
// summed over the group, so a session spanning two branches contributes to both.

import type { SessionPrPurpose } from "./session-artifact-link.js";

export type AgentSessionToolBreakdown = {
  toolName: string;
  invocationCount: number;
  errorCount: number;
  sessionCount: number;
};

export type AgentSessionAgentTypeBreakdown = {
  agentType: string;
  count: number;
  successCount: number;
  failedCount: number;
  avgDurationMs: number | null;
};

/**
 * ISS-6890 (#5209 review): how much of the population behind
 * {@link AgentSessionAgentTypeBreakdown} could not be read.
 *
 * The rows above are counts over a cohort, and a session whose persisted roster
 * is partly unreadable contributes only its READABLE members — so the rows are a
 * lower bound, not the exact population, and a consumer that sums them would
 * otherwise present the short total as the whole one. ISS-10733 deleted the
 * table that did that summing, so nothing reads this field today; it is kept
 * because it is additive and optional and its producer still emits it. This is
 * the org-wide analogue of
 * `AgentSessionDetail.rosterIncomplete`, which says the same thing about ONE
 * session's roster, and it exists because the analytics fold walks a population
 * the detail read never visits.
 *
 * It is deliberately NOT a per-row field: an unreadable member has no readable
 * agent type, so there is no bucket to attribute it to. The incompleteness is a
 * property of the whole fold, so it rides the analytics response beside the
 * rows.
 *
 * ADDITIVE AND OPTIONAL, and ABSENCE is the only encoding of "the population is
 * complete" (root `AGENTS.md` → Cross-Repo Compatibility). A producer that
 * predates this field — the desktop's local SQL/hydrate folds, which read their
 * own typed rows and have no such blob — omits it and degrades to the complete
 * reading, exactly as today. It is never serialized as `null`.
 */
export type AgentSessionAgentRosterIncompleteness = {
  /**
   * How many roster members the fold could not read across the whole
   * population, or `null` when at least one session's stored roster was not a
   * readable array at all and the number lost is genuinely unknown. Never `0` —
   * a whole population omits the field instead of reporting zero loss, so a
   * consumer never has to decide whether a present zero means "complete".
   */
  unreadableAgents: number | null;
  /** How many sessions in the population served an incomplete roster. Always positive. */
  affectedSessions: number;
};

export type AgentSessionRepositoryBreakdown = {
  repositoryFullName: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  errorCount: number;
};

export type AgentSessionUsageByBranch = {
  branchArtifactId: string;
  repositoryFullName: string | null;
  branchName: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type AgentSessionUsageByPr = {
  repositoryFullName: string;
  prNumber: number;
  prTitle: string | null;
  branchArtifactId: string;
  purpose: SessionPrPurpose;
  purposeLabel: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type AgentSessionProjectBreakdown = {
  projectId: string;
  projectName: string;
  projectSlug: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
};
