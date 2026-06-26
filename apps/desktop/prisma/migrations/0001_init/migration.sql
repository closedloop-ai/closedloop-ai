-- CreateTable
CREATE TABLE IF NOT EXISTS "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "cwd" TEXT,
    "model" TEXT,
    "started_at" TEXT,
    "updated_at" TEXT,
    "ended_at" TEXT,
    "awaiting_input_since" TEXT,
    "metadata" TEXT,
    "harness" TEXT,
    "billing_mode" TEXT,
    "user_id" TEXT,
    "organization_id" TEXT,
    "trace_phase_sources" JSONB,
    "throttle_sources" JSONB,
    "correction_sources" JSONB,
    "cost_usd_estimated" REAL,
    "cost_currency" TEXT,
    "cost_source" TEXT,
    "data_revision" INTEGER NOT NULL DEFAULT 1
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "agents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "name" TEXT,
    "type" TEXT,
    "subagent_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "task" TEXT,
    "current_tool" TEXT,
    "started_at" TEXT,
    "updated_at" TEXT,
    "ended_at" TEXT,
    "awaiting_input_since" TEXT,
    "parent_agent_id" TEXT,
    "metadata" TEXT,
    CONSTRAINT "agents_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "event_type" TEXT NOT NULL,
    "tool_name" TEXT,
    "summary" TEXT,
    "data" TEXT,
    "created_at" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "token_usage" (
    "session_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_write_tokens" BIGINT NOT NULL DEFAULT 0,
    "raw_input" BIGINT NOT NULL DEFAULT 0,
    "raw_output" BIGINT NOT NULL DEFAULT 0,
    "raw_cache_read" BIGINT NOT NULL DEFAULT 0,
    "raw_cache_write" BIGINT NOT NULL DEFAULT 0,
    "baseline_input" BIGINT NOT NULL DEFAULT 0,
    "baseline_output" BIGINT NOT NULL DEFAULT 0,
    "baseline_cache_read" BIGINT NOT NULL DEFAULT 0,
    "baseline_cache_write" BIGINT NOT NULL DEFAULT 0,
    "usage_source" TEXT NOT NULL DEFAULT 'jsonl_parser',
    "revision_id" INTEGER NOT NULL DEFAULT 4,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT,
    "cost_usd_estimated" REAL,
    "cost_currency" TEXT,
    "cost_source" TEXT,
    "cost_observed_at" TEXT,

    PRIMARY KEY ("session_id", "model")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "codex_trace_span" (
    "trace_id" TEXT NOT NULL,
    "span_id" TEXT NOT NULL,
    "parent_span_id" TEXT,
    "session_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "status_message" TEXT,
    "tool_name" TEXT,
    "attributes" JSONB,
    "resource_attributes" JSONB,
    "received_at" TEXT NOT NULL,
    "revision_id" INTEGER NOT NULL DEFAULT 4,

    PRIMARY KEY ("trace_id", "span_id"),
    CONSTRAINT "codex_trace_span_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "claude_code_cost_event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "cost_usd" DECIMAL NOT NULL,
    "observed_at" TEXT NOT NULL,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "claude_code_permission_event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "claude_code_api_request" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokens_input" BIGINT NOT NULL DEFAULT 0,
    "tokens_output" BIGINT NOT NULL DEFAULT 0,
    "tokens_cache_read" BIGINT NOT NULL DEFAULT 0,
    "tokens_cache_creation" BIGINT NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL NOT NULL,
    "started_at" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "token_events" (
    "session_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_write_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_usd_estimated" REAL,
    "input_cost_usd_estimated" REAL,
    "output_cost_usd_estimated" REAL,
    "cache_read_cost_usd_estimated" REAL,
    "cache_creation_cost_usd_estimated" REAL,
    "cost_currency" TEXT,
    "cost_source" TEXT,
    "cost_observed_at" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pack_catalog" (
    "pack_id" TEXT NOT NULL PRIMARY KEY,
    "display_name" TEXT NOT NULL,
    "category" TEXT,
    "github_url" TEXT NOT NULL,
    "marketplace_url" TEXT,
    "description" TEXT,
    "description_live" TEXT,
    "harnesses" JSONB,
    "install_commands" JSONB,
    "uninstall_commands" JSONB,
    "install_notes" TEXT,
    "placeholder_reason" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "readme_excerpt" TEXT,
    "readme_fetched_at" TEXT,
    "stars" INTEGER,
    "forks" INTEGER,
    "last_release" TEXT,
    "last_fetched_at" TEXT,
    "seed_version" INTEGER NOT NULL DEFAULT 1,
    "pin_order" INTEGER,
    "contents" JSONB,
    "contents_cache" JSONB,
    "contents_fetched_at" TEXT,
    "detection_patterns" JSONB,
    "harness_agnostic" BOOLEAN NOT NULL DEFAULT false,
    "project_scoped" BOOLEAN NOT NULL DEFAULT false,
    "single_install" BOOLEAN NOT NULL DEFAULT false,
    "post_install" JSONB
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "model_pricing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "harness" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_per_million_usd" REAL NOT NULL,
    "output_per_million_usd" REAL NOT NULL,
    "cache_read_per_million_usd" REAL NOT NULL DEFAULT 0,
    "cache_creation_per_million_usd" REAL NOT NULL DEFAULT 0,
    "effective_at" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "data_revision" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pricing_lookup_miss" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT,
    "harness" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_creation_tokens" BIGINT NOT NULL DEFAULT 0,
    "created_at" TEXT NOT NULL,
    "data_revision" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pack_catalog_history" (
    "pack_id" TEXT NOT NULL,
    "fetched_at" TEXT NOT NULL,
    "stars" INTEGER,
    "forks" INTEGER,

    PRIMARY KEY ("pack_id", "fetched_at")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pack_install_runs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pack_id" TEXT NOT NULL,
    "harness" TEXT,
    "action" TEXT NOT NULL,
    "command" TEXT,
    "exit_code" INTEGER,
    "started_at" TEXT NOT NULL,
    "ended_at" TEXT,
    "stdout_tail" TEXT,
    "stderr_tail" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_packs" (
    "pack_id" TEXT NOT NULL,
    "harness" TEXT NOT NULL,
    "install_path" TEXT NOT NULL,
    "install_kind" TEXT,
    "source_url" TEXT,
    "version" TEXT,
    "detected_at" TEXT,
    "last_seen_at" TEXT,
    "uninstalled_at" TEXT,

    PRIMARY KEY ("pack_id", "harness", "install_path")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "skills" (
    "skill_id" TEXT NOT NULL PRIMARY KEY,
    "pack_id" TEXT,
    "harness" TEXT,
    "install_path" TEXT,
    "name" TEXT,
    "version" TEXT,
    "description" TEXT,
    "source_url" TEXT,
    "detected_at" TEXT,
    "last_seen_at" TEXT,
    "uninstalled_at" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "project_pack_associations" (
    "project_path" TEXT NOT NULL,
    "pack_id" TEXT NOT NULL,
    "detected_at" TEXT,
    "last_seen_at" TEXT,

    PRIMARY KEY ("project_path", "pack_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "plans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT,
    "capture_method" TEXT,
    "harness" TEXT,
    "created_from_session_id" TEXT,
    "created_from_event_id" TEXT,
    "plan_key" TEXT,
    "file_path" TEXT,
    "source_log_path" TEXT,
    "needs_confirmation" BOOLEAN NOT NULL DEFAULT false,
    "confidence" REAL NOT NULL DEFAULT 1.0,
    "sync_state" TEXT,
    "metadata" JSONB,
    "created_at" TEXT,
    "updated_at" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "plan_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "plan_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "content_markdown" TEXT,
    "content_json" JSONB,
    "content_sha256" TEXT,
    "author_type" TEXT,
    "author_user_id" TEXT,
    "source_session_id" TEXT,
    "source_event_ref" TEXT,
    "capture_method" TEXT,
    "created_at" TEXT,
    CONSTRAINT "plan_versions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pull_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT,
    "pr_url" TEXT NOT NULL,
    "pr_number" INTEGER,
    "repo_full_name" TEXT,
    "branch_name" TEXT,
    "head_sha" TEXT,
    "state" TEXT,
    "closed_at" TEXT,
    "merged_at" TEXT,
    "title" TEXT,
    "harness" TEXT,
    "observed_at" TEXT,
    "created_at" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pr_backfill_seen" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "file_path" TEXT,
    "file_mtime_ms" BIGINT,
    "scanned_at" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identity_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "repo_full_name" TEXT,
    "git_dir" TEXT,
    "sha" TEXT,
    "branch_name" TEXT,
    "pr_number" INTEGER,
    "slug" TEXT,
    "url" TEXT,
    "title" TEXT,
    "harness" TEXT,
    "head_sha" TEXT,
    "lines_added" INTEGER,
    "lines_removed" INTEGER,
    "files_changed" INTEGER,
    "enrichment_state" TEXT,
    "enrichment_source" TEXT,
    "enrichment_attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_at" TEXT,
    "enriched_at" TEXT,
    "pr_state" TEXT,
    "merge_commit_sha" TEXT,
    "base_ref" TEXT,
    "observed_at" TEXT,
    "created_at" TEXT NOT NULL,
    "last_seen_at" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "repos" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "git_dir" TEXT NOT NULL,
    "remote_url" TEXT,
    "repo_full_name" TEXT,
    "default_branch" TEXT,
    "last_seen_at" TEXT NOT NULL,
    "created_at" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "repo_worktrees" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repo_id" TEXT NOT NULL,
    "worktree_path" TEXT NOT NULL,
    "branch_name" TEXT,
    "last_seen_at" TEXT NOT NULL,
    CONSTRAINT "repo_worktrees_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pull_request_status_observations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repo_full_name" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "pr_url" TEXT,
    "state" TEXT NOT NULL,
    "is_draft" BOOLEAN,
    "head_ref_name" TEXT,
    "head_sha" TEXT,
    "title" TEXT,
    "author_login" TEXT,
    "pr_created_at" TEXT,
    "pr_updated_at" TEXT,
    "source" TEXT NOT NULL,
    "observed_at" TEXT NOT NULL,
    "last_checked_at" TEXT NOT NULL,
    "next_refresh_after" TEXT,
    "error" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pricing_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "model_key" TEXT NOT NULL,
    "description" TEXT,
    "input_price_per_1k" DECIMAL NOT NULL,
    "output_price_per_1k" DECIMAL NOT NULL,
    "cache_read_factor" DECIMAL NOT NULL DEFAULT 0.1,
    "cache_write_factor" DECIMAL NOT NULL DEFAULT 1.25,
    "us_surcharge" DECIMAL NOT NULL DEFAULT 0.1,
    "batch_discount" DECIMAL NOT NULL DEFAULT 0.5,
    "web_search_price" DECIMAL NOT NULL DEFAULT 10.0,
    "code_exec_price" DECIMAL NOT NULL DEFAULT 0.05,
    "code_exec_free_hours" INTEGER NOT NULL DEFAULT 1550,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "session_artifact_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "extractor_version" INTEGER NOT NULL,
    "observed_at" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "session_artifact_links_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "session_artifact_links_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sync_state" (
    "source_key" TEXT NOT NULL PRIMARY KEY,
    "observed_top_updated_at" TEXT,
    "observed_ids_at_top_updated_at" JSONB NOT NULL DEFAULT [],
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "artifact_link_backfill_seen" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "file_path" TEXT,
    "file_mtime_ms" BIGINT,
    "extractor_version" INTEGER NOT NULL,
    "scanned_at" TEXT,
    CONSTRAINT "artifact_link_backfill_seen_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_sessions_started_at" ON "sessions"("started_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_sessions_status_started_at" ON "sessions"("status", "started_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_sessions_user_id" ON "sessions"("user_id") WHERE user_id IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_sessions_organization_id" ON "sessions"("organization_id") WHERE organization_id IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agents_session_id" ON "agents"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agents_status" ON "agents"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agents_type" ON "agents"("type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agents_parent" ON "agents"("parent_agent_id") WHERE parent_agent_id IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_events_session_id" ON "events"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_events_agent_id" ON "events"("agent_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_events_created_at" ON "events"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_events_tool_name" ON "events"("tool_name") WHERE tool_name IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_events_session_tool" ON "events"("session_id", "created_at") WHERE tool_name IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_events_user_prompt_created_session" ON "events"("created_at" DESC, "session_id") WHERE event_type = 'UserPromptSubmit';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_events_tool_created" ON "events"("created_at", "tool_name") WHERE tool_name IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_token_usage_session" ON "token_usage"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_codex_trace_span_session" ON "codex_trace_span"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_codex_trace_span_tool" ON "codex_trace_span"("tool_name") WHERE tool_name IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_codex_trace_span_start_time" ON "codex_trace_span"("start_time");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_cost_event_session" ON "claude_code_cost_event"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_cost_event_observed" ON "claude_code_cost_event"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_cost_event_natural" ON "claude_code_cost_event"("session_id", "model", "observed_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_permission_event_session" ON "claude_code_permission_event"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_permission_event_observed" ON "claude_code_permission_event"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_permission_event_natural" ON "claude_code_permission_event"("session_id", "tool_name", "observed_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_api_request_session" ON "claude_code_api_request"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_claude_code_api_request_started" ON "claude_code_api_request"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_claude_code_api_request_natural" ON "claude_code_api_request"("session_id", "started_at", "model");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_token_events_session" ON "token_events"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_token_events_created" ON "token_events"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_model_pricing_lookup" ON "model_pricing"("harness", "model", "effective_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_pricing_unique_effective" ON "model_pricing"("harness", "model", "effective_at", "source");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_pricing_lookup_miss_lookup" ON "pricing_lookup_miss"("harness", "model", "observed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pricing_lookup_miss_unique" ON "pricing_lookup_miss"("harness", "model", "observed_at", "session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_install_runs_pack" ON "pack_install_runs"("pack_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agent_packs_pack" ON "agent_packs"("pack_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_skills_pack" ON "skills"("pack_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_skills_name" ON "skills"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_plans_session" ON "plans"("created_from_session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_plans_needs_confirmation" ON "plans"("needs_confirmation") WHERE needs_confirmation = TRUE;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_plans_updated" ON "plans"("updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plans_session_key" ON "plans"("created_from_session_id", "plan_key") WHERE plan_key IS NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_plan_versions_plan" ON "plan_versions"("plan_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_pr_session" ON "pull_requests"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_pr_repo" ON "pull_requests"("repo_full_name", "pr_number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_pr_observed" ON "pull_requests"("observed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_identity_key_key" ON "artifacts"("identity_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_artifacts_kind" ON "artifacts"("kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_artifacts_repo_pr" ON "artifacts"("repo_full_name", "pr_number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_artifacts_sweep" ON "artifacts"("enrichment_state");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "repos_git_dir_key" ON "repos"("git_dir");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_repos_full_name" ON "repos"("repo_full_name") WHERE repo_full_name IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "repo_worktrees_worktree_path_key" ON "repo_worktrees"("worktree_path");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_repo_worktrees_repo" ON "repo_worktrees"("repo_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_pr_status_state" ON "pull_request_status_observations"("state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_pr_status_next_refresh" ON "pull_request_status_observations"("next_refresh_after");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pr_status_repo_number" ON "pull_request_status_observations"("repo_full_name", "pr_number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pricing_rules_model" ON "pricing_rules"("model_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_sal_session" ON "session_artifact_links"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_sal_artifact" ON "session_artifact_links"("artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "session_artifact_links_session_artifact_relation_key" ON "session_artifact_links"("session_id", "artifact_id", "relation");

-- ============================================================================
-- FEA-2038: migrations 0002–0005 collapsed into this genesis migration. The
-- desktop store moved engines (PGlite→SQLite) on this branch and no SQLite
-- migration has ever shipped, so a fresh install runs ONE migration rather than
-- stepping through five. (History below preserved verbatim from the prior dirs.)
-- ============================================================================

-- [0002] Covering index for the dashboard analytics access pattern: the
-- Utilization/Agents insight queries read `events` by session_id and group/filter
-- on event_type/created_at. Lets SQLite serve them from a narrow index.
CREATE INDEX IF NOT EXISTS "idx_events_session_type_created" ON "events"("session_id", "event_type", "created_at");

-- [0003] Indexes for the O(grouped) dashboard analytics aggregation (byTool groups
-- `events` by tool_name + distinct session_id; byRepository groups `sessions` by
-- cwd). Partial indexes so SQLite serves the grouped reads from an index.
CREATE INDEX IF NOT EXISTS "idx_events_tool_session" ON "events"("tool_name", "session_id") WHERE tool_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_sessions_cwd" ON "sessions"("cwd") WHERE cwd IS NOT NULL;

-- [0004] Per-session analytics rollups, computed once at ingest so the dashboard
-- insights read cheap aggregates instead of re-scanning + re-classifying events.
CREATE TABLE IF NOT EXISTS "session_analytics" (
  "session_id" TEXT NOT NULL PRIMARY KEY,
  "started_at" TEXT,
  "started_day" TEXT,
  "status" TEXT,
  "harness" TEXT,
  "is_human" INTEGER NOT NULL DEFAULT 0,
  "human_turns" INTEGER NOT NULL DEFAULT 0,
  "agent_turns" INTEGER NOT NULL DEFAULT 0,
  "event_count" INTEGER NOT NULL DEFAULT 0,
  "tool_invocations" INTEGER NOT NULL DEFAULT 0,
  "error_events" INTEGER NOT NULL DEFAULT 0,
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
  "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
  "est_cost" REAL NOT NULL DEFAULT 0,
  "runtime_ms" INTEGER,
  "updated_at" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_session_analytics_started_day" ON "session_analytics"("started_day");

CREATE TABLE IF NOT EXISTS "session_tool_analytics" (
  "session_id" TEXT NOT NULL,
  "tool_name" TEXT NOT NULL,
  "invocations" INTEGER NOT NULL DEFAULT 0,
  "started_day" TEXT,
  PRIMARY KEY ("session_id", "tool_name")
);
CREATE INDEX IF NOT EXISTS "idx_session_tool_analytics_tool" ON "session_tool_analytics"("tool_name");
CREATE INDEX IF NOT EXISTS "idx_session_tool_analytics_day" ON "session_tool_analytics"("started_day");

-- [0005] PRD-486 / PLN-1037: event-time commit + PR-opened metadata for the
-- branch rail. committed_at on kind='commit' artifacts; opened_at on PRs.
ALTER TABLE "artifacts" ADD COLUMN "committed_at" TEXT;
ALTER TABLE "pull_requests" ADD COLUMN "opened_at" TEXT;
