/**
 * @file db-row-types.ts
 * @description Structural row shapes for the desktop SQLite store — the raw
 * result rows that read/write code casts query output into. Most declarations
 * are types extracted verbatim from `sqlite.ts`; persisted trust boundaries may
 * also define their runtime validator here so the structural row contract has
 * one canonical owner.
 */

import { z } from "zod";
import type { SessionPR } from "../agent-sync/agent-session-sync-contract.js";

type SqliteSessionRow = {
  id: string;
  name: string | null;
  status: string;
  cwd: string | null;
  // FEA-3555: durable cache of the last successfully live-resolved repo full
  // name for this session's worktree (see the `repo_full_name` column comment
  // in schema.prisma). Read as a fallback when the live git remote lookup fails.
  repo_full_name: string | null;
  model: string | null;
  started_at: string;
  updated_at: string;
  // PLN-1034 / ISS-5443: the denormalized genuine-activity timestamp, maintained
  // at ingest by `recomputeSessionLastActivityAt` as
  // `MAX(started_at floor, MAX(events.created_at))`. NOT NULL with an epoch
  // default (migration 0005). This column is the SSOT the Sessions list SORTS by
  // and every Sessions date window bounds on, so the hydrated projection reads
  // it rather than re-deriving the same formula from whatever event rows a given
  // load happened to fetch. Optional on the row type because not every SELECT in
  // this file projects it.
  last_activity_at?: string | null;
  ended_at: string | null;
  awaiting_input_since: string | null;
  // ISS-4586: SQLite boolean (0/1/NULL) — whether the run ended on an unrecovered
  // error. Synced additively to the cloud so its reaper can classify orphans.
  ends_with_error: number | null;
  metadata: string | null;
  harness: string | null;
  billing_mode: string | null;
  user_id: string | null;
  organization_id: string | null;
  cost_usd_estimated: number | null;
  cost_currency: string | null;
  cost_source: string | null;
  data_revision: number;
};

type SqliteAgentRow = {
  id: string;
  session_id: string;
  name: string;
  type: string;
  subagent_type: string | null;
  status: string;
  task: string | null;
  current_tool: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  awaiting_input_since: string | null;
  parent_agent_id: string | null;
  metadata: string | null;
};

type SqliteEventRow = {
  id: string;
  session_id: string;
  agent_id: string | null;
  event_type: string;
  tool_name: string | null;
  summary: string | null;
  data: string | null;
  created_at: string;
};

type SqliteTokenUsageRow = {
  session_id: string;
  model: string;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  // FEA-3419: cache-write TTL subdivision; NULL = never reported (absent).
  // Optional because only TTL-aware read paths SELECT them.
  cache_write_5m_tokens?: unknown;
  cache_write_1h_tokens?: unknown;
  // FEA-2922: pre-compaction baselines folded into the effective totals the
  // cloud sees (mirrors the session_analytics rollup). Optional because only
  // the sync projection SELECTs them; the cost-only read paths omit them.
  baseline_input?: unknown;
  baseline_output?: unknown;
  baseline_cache_read?: unknown;
  baseline_cache_write?: unknown;
  created_at: string | null;
  cost_usd_estimated: number | null;
};

type SqliteTokenEventRow = {
  session_id: string;
  transport_id: string | null;
  model: string;
  created_at: string;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  // FEA-3419: per-event cache-write TTL subdivision; NULL = never reported.
  cache_write_5m_tokens?: unknown;
  cache_write_1h_tokens?: unknown;
  cost_usd_estimated: number | null;
  input_cost_usd_estimated: number | null;
  output_cost_usd_estimated: number | null;
  cache_read_cost_usd_estimated: number | null;
  cache_creation_cost_usd_estimated: number | null;
  source_identity: string | null;
  cost_summary: string | null;
};

// FEA-2730 (G10): the desktop `session_analytics` rollup row (one per session).
type SqliteSessionAnalyticsRow = {
  session_id: string;
  started_at: string | null;
  started_day: string | null;
  status: string | null;
  harness: string | null;
  is_human: number;
  human_turns: number;
  agent_turns: number;
  event_count: number;
  tool_invocations: number;
  error_events: number;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  est_cost: number | null;
  runtime_ms: number | null;
  updated_at: string | null;
};

type SqliteArtifactLinkRow = {
  link_id?: string;
  session_id: string;
  target_kind: string;
  slug: string | null;
  is_primary: boolean;
  method: string;
  link_evidence?: string | null;
  repo_full_name: string | null;
  pr_number: number | null;
  url: string | null;
  relation: string | null;
  sha: string | null;
  title: string | null;
  branch_name: string | null;
  lines_added: number | null;
  lines_removed: number | null;
  files_changed: number | null;
  link_observed_at: string | null;
  artifact_committed_at: string | null;
  artifact_observed_at: string | null;
  artifact_last_seen_at: string | null;
  // FEA-2732: PR state from the joined `artifacts` (kind='pull_request') row,
  // synced into the cloud PullRequestDetail via the `pull_request` artifactRef.
  // (LOC facts reuse the shared lines_added/lines_removed/files_changed above.)
  pr_state: string | null;
  // FEA-3329: the AUTHORITATIVE PR-opened instant from `pull_requests.opened_at`
  // (GitHub metadata via enrichment), joined for the PR timeline marker so it
  // lands at its real opened time — not the shared per-import ingest `now` on
  // `link_observed_at`. Null until the PR is enriched.
  pr_opened_at: string | null;
};

type SqlitePullRequestRow = {
  session_id: string;
  pr_number: number | null;
  repo_full_name: string | null;
  title: string | null;
  state: string | null;
  closed_at: string | null;
  merged_at: string | null;
  observed_at: string | null;
};

// FEA-2732: PR lifecycle facts not carried on the `artifacts` row — merged/closed
// timestamps from the per-session `pull_requests` store and the latest `is_draft`
// observation from `pull_request_status_observations`. Keyed per session by
// (repo_full_name, pr_number) to enrich the `pull_request` artifactRef.
type SqlitePullRequestLifecycleRow = {
  session_id: string;
  pr_number: number | null;
  repo_full_name: string | null;
  merged_at: string | null;
  closed_at: string | null;
  // Raw SQLite reads return 0/1 integers for booleans (never JS booleans).
  is_draft: boolean | number | null;
};

type SqliteGitLocRow = {
  session_id: string;
  total_added: number;
  total_removed: number;
  total_files: number;
  // FEA-3633: LOC provenance for the per-branch dedup. "commit" when the LOC are
  // the session's own authored-commit sums (priority-1 path); "branch_fallback"
  // when they fell back to the linked branch/PR artifact's FULL total (per-commit
  // enrichment unavailable, e.g. RTK strips SHAs). Absent on the ungated
  // branchLocRows read (always the branch total by construction).
  loc_basis?: string | null;
};

type SessionPrWithIdentity = SessionPR & {
  repositoryFullName?: string | null;
};

type TokenUsagePricingRow = {
  model: string;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  // FEA-3419: current-only TTL subdivision (never baseline-folded — compaction
  // baselines are unclassified by design); NULL = never reported.
  cache_write_5m_tokens?: unknown;
  cache_write_1h_tokens?: unknown;
  created_at: string | null;
  // 0/1, computed from TOKEN_USAGE_EVENT_PARITY_SOURCE_FILTER: whether the row
  // may reconcile against token_events (OTel-only rows have no event series).
  parity_eligible: unknown;
};

export type {
  SessionPrWithIdentity,
  SqliteAgentRow,
  SqliteArtifactLinkRow,
  SqliteEventRow,
  SqliteGitLocRow,
  SqlitePullRequestLifecycleRow,
  SqlitePullRequestRow,
  SqliteSessionAnalyticsRow,
  SqliteSessionRow,
  SqliteTokenEventRow,
  SqliteTokenUsageRow,
  TokenUsagePricingRow,
};

/** Runtime shape of one persisted repository-default authority row. */
export const storedRepositoryDefaultAuthoritySchema = z.object({
  identityKey: z.string(),
  provider: z.string(),
  providerRepositoryId: z.string(),
  repoFullName: z.string(),
  defaultBranch: z.string().nullable(),
  availability: z.string(),
  completeness: z.string(),
  reason: z.string().nullable(),
  source: z.string(),
  sourceIdentity: z.string().nullable(),
  mechanism: z.string(),
  trigger: z.string(),
  credentialType: z.string(),
  credentialOwnerId: z.string().nullable(),
  observationKey: z.string(),
  observedAt: z.string(),
  eventAt: z.string().nullable(),
  updatedAt: z.string(),
});

/** Canonical structural type derived from the persisted row validator. */
export type StoredRepositoryDefaultAuthority = z.infer<
  typeof storedRepositoryDefaultAuthoritySchema
>;
