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
