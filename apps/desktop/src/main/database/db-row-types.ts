/**
 * @file db-row-types.ts
 * @description Structural row shapes for the desktop SQLite store — the raw
 * result rows that read/write code casts query output into. Most declarations
 * are types extracted verbatim from `sqlite.ts`; persisted trust boundaries may
 * also define their runtime validator here so the structural row contract has
 * one canonical owner.
 */

import type { Priority } from "@repo/api/src/types/common";
import type { SessionPR } from "../agent-sync/agent-session-sync-contract.js";

type SqliteSessionRow = {
  id: string;
  name: string | null;
  // ISS-8717: the owner's rename, if any. Distinct from `name`, which the
  // importer re-derives from the transcript on every import.
  name_override?: string | null;
  // ISS-10332: the user-set priority; NULL is "no priority".
  priority: Priority | null;
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
  // ISS-12251: canonical UTC ISO, or NULL when never imported. Optional because
  // not every SELECT projects it.
  created_at?: string | null;
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
  // ISS-7229: Claude's OWN reported cost, rolled up from `claude_code_cost_event`.
  // Optional on the row type for the same reason `last_activity_at` is — not
  // every SELECT in this file projects it. `null` means no OTel cost events were
  // captured for the session, which is NOT the same as a reported zero.
  // NOT `number` (review of #6406). The raw-query driver maps this REAL column
  // to a Prisma `Decimal`, which `stored-cost-usd.ts` documents having already
  // caused two defects — a `typeof` test that reported every backfilled session
  // unusable, and a bare `Number()` that worked only because `Decimal` carries a
  // `valueOf`. Typing it as the shape the driver actually returns forces every
  // reader through `coerceStoredCostUsd` instead of trusting a number.
  authoritative_cost_usd?: unknown;
  data_revision: number;
};

type SqliteAgentRow = {
  id: string;
  session_id: string;
  name: string;
  type: string;
  subagent_type: string | null;
  status: string;
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
  // ISS-6227: optional, because a narrowed (`omitTokenEventCostColumns`) read
  // omits these two sync-only columns from the SELECT list entirely rather than
  // paying for a NULL cell per row. Both consumers (`parseStoredTokenSourceIdentity`,
  // `parseStoredTokenCostSummary`) already map `null` and `undefined` to the same
  // `undefined`, so an absent property is indistinguishable downstream from the
  // NULL cell it replaced.
  source_identity?: string | null;
  cost_summary?: string | null;
  // ISS-12552: NULL is the main agent. Optional because a row type built by
  // hand for a test or a read that predates the column carries no cell.
  agent_id?: string | null;
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
  // ISS-10332: the joined artifact's priority (only branch rows carry one).
  priority: Priority | null;
  link_observed_at: string | null;
  artifact_committed_at: string | null;
  artifact_observed_at: string | null;
  artifact_last_seen_at: string | null;
  // ISS-8175: the base ref gh named when THIS desktop opened the PR, from the
  // joined `artifacts` row. Null for a merely referenced PR, and for any PR
  // created before the extractor learned to capture it.
  base_ref: string | null;
  // FEA-3329: the AUTHORITATIVE PR-opened instant from `pull_requests.opened_at`,
  // joined for the PR timeline marker so it lands at its real opened time — not
  // the shared per-import ingest `now` on `link_observed_at`. Null unless some
  // earlier release stored one: the GitHub-metadata enrichment lane that wrote
  // that column was deleted by PLN-1535 (PR #4435), so a null is not a
  // not-yet-enriched value this tree will ever fill in.
  pr_opened_at: string | null;
};

type SqlitePullRequestRow = {
  session_id: string;
  pr_number: number | null;
  repo_full_name: string | null;
  title: string | null;
  closed_at: string | null;
  observed_at: string | null;
};

// FEA-2732: PR lifecycle facts not carried on the `artifacts` row — the closed
// timestamp from the per-session `pull_requests` store. Keyed per session by
// (repo_full_name, pr_number) to enrich the `pull_request` artifactRef.
type SqlitePullRequestLifecycleRow = {
  session_id: string;
  pr_number: number | null;
  repo_full_name: string | null;
  closed_at: string | null;
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

/**
 * T-8.6: per-session usage row from `agent_component_session_usage`, read by
 * `sync-source.ts` and budgeted by `component-usage-budget.ts`.
 */
type SqliteComponentUsageRow = {
  session_id: string;
  component_kind: string;
  component_key: string;
  // FEA-2990: '' sentinel for branch-less buckets; carried to the cloud so it
  // can attribute component usage per-branch when present.
  git_branch: string;
  agent_component_id: string | null;
  harness: string | null;
  invocations: number;
  error_count: number;
  component_version_hash: string | null;
  first_invoked_at: string | null;
  last_invoked_at: string | null;
};

export type {
  SessionPrWithIdentity,
  SqliteAgentRow,
  SqliteArtifactLinkRow,
  SqliteComponentUsageRow,
  SqliteEventRow,
  SqlitePullRequestLifecycleRow,
  SqlitePullRequestRow,
  SqliteSessionAnalyticsRow,
  SqliteSessionRow,
  SqliteTokenEventRow,
  SqliteTokenUsageRow,
  TokenUsagePricingRow,
};
