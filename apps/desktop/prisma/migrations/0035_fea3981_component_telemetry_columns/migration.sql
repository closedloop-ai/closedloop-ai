-- FEA-3981 (PLN-1488) per-component telemetry — Slice A (additive schema only).
--
-- All new columns are nullable with NO default: legacy rows stay NULL, which
-- means "not computed". Capture lands in Slice B; this migration only adds the
-- columns so that slice has somewhere to write. Each ADD COLUMN is a
-- metadata-only op in SQLite (one column per ALTER statement).
--
-- These columns live at the per-INVOCATION grain (agent_component_invocations —
-- one row per invocation), NOT on the component-level agent_component_session_usage
-- rollup. That rollup's PK is (session, kind, key, git_branch), so a subagent
-- that ran under BOTH opus and sonnet in one session/branch collapses into ONE
-- usage row — a scalar `model` there could not represent "mixed". At the
-- invocation grain, a multi-model subagent yields one row per model turn, so
-- mixed-model is naturally representable; the component-level rollup DERIVES its
-- token/cost totals and its model SET by aggregating these rows (Slice D read).
--   (a) real per-SUBAGENT token/model/cost: model, input/output/cache tokens,
--       estimated_cost — only subagent-kind invocations populate these. SQLite
--       dialect: BIGINT (Prisma BigInt, INTEGER affinity) for token counts,
--       REAL (Prisma Float) for cost, TEXT for model — matching the existing
--       token_usage BigInt convention (migration 0001).
--   (b) per-component result-FOOTPRINT tokens (footprint_tokens): the
--       deterministic "tokens this component injected into context" metric,
--       computed for ALL component kinds.

-- AlterTable
ALTER TABLE "agent_component_invocations" ADD COLUMN "model" TEXT;
ALTER TABLE "agent_component_invocations" ADD COLUMN "input_tokens" BIGINT;
ALTER TABLE "agent_component_invocations" ADD COLUMN "output_tokens" BIGINT;
ALTER TABLE "agent_component_invocations" ADD COLUMN "cache_read_tokens" BIGINT;
ALTER TABLE "agent_component_invocations" ADD COLUMN "cache_write_tokens" BIGINT;
ALTER TABLE "agent_component_invocations" ADD COLUMN "estimated_cost" REAL;
ALTER TABLE "agent_component_invocations" ADD COLUMN "footprint_tokens" BIGINT;
