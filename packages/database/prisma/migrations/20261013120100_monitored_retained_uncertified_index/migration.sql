-- #8737 follow-up — the retained monitored-activity rows SQL cannot certify,
-- indexed by session.
--
-- WHY. A session-detail read renders the untracked repositories a session
-- touched, and reports how many of its retained rows are unreadable (their
-- `after` does not parse). It used to read every retained row of the session
-- and parse each one. It now ships one row per target, plus the rows SQL
-- cannot certify as parseable, and those are the rows this index holds.
-- Certification runs ONCE, when Postgres maintains this index on insert, rather
-- than over the whole session on every read. A writer-shaped row certifies, so
-- the index stays near-empty in practice.
--
-- THE PREDICATE IS GENERATED, NOT HAND-WRITTEN: it is
-- `UNCERTIFIED_RETAINED_SNAPSHOT_SQL`
-- (apps/api/app/agent-sessions/service/session-untracked-repositories-rows.ts)
-- verbatim, and the read splices the same text so the planner can prove it.
-- Change the two together. Whichever changes alone, the read stops using this
-- index, and the integration suite beside that module fails.
--
-- Declared in schema.prisma with Postgres's normalized predicate, as a partial
-- index with plain key columns.
--
-- CONCURRENTLY, so this file is ONE bare statement: do not add BEGIN/COMMIT or a
-- `DO` block. NO `IF NOT EXISTS`, per scripts/lint/destructive-migrations/
-- index-ddl.ts: a retry over an INVALID remnant must fail closed (42P07). To
-- recover from a cancelled build, drop the remnant once and re-deploy:
--       DROP INDEX IF EXISTS "artifact_activity_events_monitored_retained_uncertified_idx";
CREATE INDEX CONCURRENTLY "artifact_activity_events_monitored_retained_uncertified_idx" ON "artifact_activity_events" ("organization_id", "artifact_id") WHERE "action" = 'monitored_activity_retained' AND (jsonb_typeof(after -> 'repositoryFullName') = 'string'
   AND (after ->> 'repositoryFullName') <> ''
   AND CASE (after ->> 'kind')
     WHEN 'branch' THEN
       jsonb_typeof(after -> 'branchName') = 'string' AND length(after ->> 'branchName') >= 1
     WHEN 'pull_request' THEN
       CASE WHEN jsonb_typeof(after -> 'prNumber') = 'number' THEN
         (after ->> 'prNumber')::numeric = trunc((after ->> 'prNumber')::numeric)
         AND (after ->> 'prNumber')::numeric > 0
         AND (after ->> 'prNumber')::numeric <= 2147483647
       ELSE false END
     ELSE false
   END
   AND jsonb_typeof(after -> 'kind') = 'string'
   AND ((after -> 'url') IS NULL OR jsonb_typeof(after -> 'url') = 'string')
   AND jsonb_typeof(after -> 'eventKind') = 'string'
   AND (after ->> 'eventKind') = ANY (ARRAY['user_reference', 'agent_read', 'agent_action'])
   AND jsonb_typeof(after -> 'occurredAt') = 'string'
   AND (after ->> 'occurredAt') ~ '^[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))T(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.[0-9]+)?)?Z$'
   AND jsonb_typeof(after -> 'completeness') = 'string'
   AND (after ->> 'completeness') = ANY (ARRAY['complete', 'partial'])
   AND jsonb_typeof(after -> 'disposition') = 'string'
   AND (after ->> 'disposition') = ANY (ARRAY['intentionally_absent', 'repository_unfetchable', 'repository_out_of_scope', 'repository_identity_unknown', 'authority_conflict', 'provider_identity_ambiguous', 'target_not_materialized', 'hold_expired'])
   AND ((after -> 'holdExpiryCause') IS NULL OR (jsonb_typeof(after -> 'holdExpiryCause') = 'string' AND (after ->> 'holdExpiryCause') = ANY (ARRAY['own_age', 'escalation'])))) IS NOT TRUE;
