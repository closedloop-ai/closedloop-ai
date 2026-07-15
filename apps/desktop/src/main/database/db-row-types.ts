/**
 * @file db-row-types.ts
 * @description Structural row shapes for the desktop SQLite store — the raw
 * result rows that read/write code casts query output into. These are pure type
 * declarations with no runtime code, extracted verbatim from `sqlite.ts` so the
 * domain modules carved out of that monolith can share one canonical set of row
 * shapes instead of re-declaring them.
 */
import type { SessionPR } from "../agent-session-sync-contract.js";

type SqliteSessionRow = {
  id: string;
  name: string | null;
  status: string;
  cwd: string | null;
  model: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  awaiting_input_since: string | null;
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
  model: string;
  created_at: string;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  cost_usd_estimated: number | null;
  input_cost_usd_estimated: number | null;
  output_cost_usd_estimated: number | null;
  cache_read_cost_usd_estimated: number | null;
  cache_creation_cost_usd_estimated: number | null;
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
  session_id: string;
  target_kind: string;
  slug: string | null;
  is_primary: boolean;
  method: string;
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
  created_at: string | null;
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
