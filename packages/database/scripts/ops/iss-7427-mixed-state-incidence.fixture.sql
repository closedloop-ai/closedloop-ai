-- ISS-7427 — a throwaway fixture that EXERCISES
-- `iss-7427-mixed-state-incidence.sql` so its cohort rules can be checked
-- without production access.
--
-- NEVER run this against a real database: it CREATEs tables. It builds the
-- narrow slice of the schema the audit reads (the columns, names and types the
-- audit references — not the full models) plus eleven sessions chosen so that
-- every arm of the disposition fold and both cohort predicates are hit, and at
-- least one row would move if any single rule were widened or narrowed.
--
--   docker run -d --name iss7427-pg -e POSTGRES_PASSWORD=pg -e POSTGRES_USER=pg \
--     -e POSTGRES_DB=iss7427 -p 57427:5432 postgres:16
--   psql "postgres://pg:pg@127.0.0.1:57427/iss7427" -f iss-7427-mixed-state-incidence.fixture.sql
--   psql "postgres://pg:pg@127.0.0.1:57427/iss7427" -f iss-7427-mixed-state-incidence.sql
--
-- EXPECTED, derived by hand from the fold rules rather than from a previous run
-- of the audit (a fixture read off its own subject proves nothing):
--
--   window  denominator  served  derived  no_main_row
--   07d     9            4       3        1
--   30d     10           5       4        1
--   all     11           6       5        1
--
--   dispositions over `all`: synced 1, stale 1, syncing 1, failedTransient 1,
--   failedPermanent 6, neverExpected 1  (= 11)
--
-- S5 (skipped, NULL reason) is failedPermanent, NOT syncing: the code's
-- `dispositionForTerminalSkipReason` returns FailedPermanent for a null reason
-- deliberately, so an unclassifiable value never reads as recoverable. Only
-- `materialized_source_unavailable` (S4) is the recoverable terminal.

\set ON_ERROR_STOP on

DROP TABLE IF EXISTS agent_session_events, session_transcript, session_detail, artifacts CASCADE;

CREATE TABLE artifacts (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id      uuid,
  name            text NOT NULL,
  type            text NOT NULL,
  status          text NOT NULL,
  assignee_id     uuid
);

CREATE TABLE session_detail (
  artifact_id          uuid PRIMARY KEY REFERENCES artifacts(id),
  compute_target_id    uuid NOT NULL,
  external_session_id  text NOT NULL,
  harness              text NOT NULL DEFAULT 'unknown',
  origin               text NOT NULL DEFAULT 'DESKTOP_SYNC',
  model                text,
  state                text,
  repository_full_name text,
  session_started_at   timestamptz NOT NULL,
  session_ended_at     timestamptz,
  input_tokens         bigint NOT NULL DEFAULT 0,
  output_tokens        bigint NOT NULL DEFAULT 0,
  cache_read_tokens    bigint NOT NULL DEFAULT 0,
  cache_write_tokens   bigint NOT NULL DEFAULT 0,
  estimated_cost       numeric(14, 6) NOT NULL DEFAULT 0,
  UNIQUE (compute_target_id, external_session_id)
);

CREATE TABLE session_transcript (
  id                       uuid PRIMARY KEY,
  organization_id          uuid NOT NULL,
  compute_target_id        uuid NOT NULL,
  external_session_id      text NOT NULL,
  session_detail_id        uuid REFERENCES session_detail(artifact_id),
  file_key                 text NOT NULL,
  upload_status            text NOT NULL DEFAULT 'pending',
  permanent_failure_reason text,
  last_observed_at         timestamptz NOT NULL,
  uploaded_at              timestamptz,
  UNIQUE (compute_target_id, external_session_id, file_key)
);

CREATE TABLE agent_session_events (
  id                uuid PRIMARY KEY,
  agent_session_id  uuid NOT NULL REFERENCES session_detail(artifact_id),
  external_event_id text NOT NULL,
  event_created_at  timestamptz NOT NULL
);

-- Eleven sessions. `n` is the session number; ids are derived from it so a row
-- can be named in a failure message. `days` is its age.
INSERT INTO artifacts (id, organization_id, project_id, name, type, status)
SELECT
  ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-0000000000aa'::uuid,
  '00000000-0000-4000-8000-0000000000bb'::uuid,
  'session-' || n,
  'SESSION',
  'INACTIVE'
FROM generate_series(1, 11) AS n;

INSERT INTO session_detail (
  artifact_id, compute_target_id, external_session_id, harness, model,
  state, repository_full_name, session_started_at, session_ended_at,
  input_tokens, estimated_cost
)
VALUES
  -- S1 healthy: main uploaded and current.
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000d1', 'ext-1', 'claude', 'sonnet', 'inactive', 'acme/app', now() - interval '1 day',  now() - interval '1 day', 100, 5),
  -- S2 THE REPORTED SHAPE: terminal skip + full metrics.
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000d1', 'ext-2', 'codex',  'gpt-5.5', 'inactive', 'acme/app', now() - interval '2 days', now() - interval '2 days', 8990000000, 5994.85),
  -- S3 terminal skip, NO independent evidence: served cohort only.
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000d1', 'ext-3', 'claude', NULL, NULL, NULL, now() - interval '3 days', NULL, 0, 0),
  -- S4 skip with a RECOVERABLE reason -> syncing, must not be flagged.
  ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000d1', 'ext-4', 'opencode', 'sonnet', 'inactive', 'acme/web', now() - interval '4 days', NULL, 50, 3),
  -- S5 skip with an ABSENT reason -> failedPermanent (the conservative default
  -- for a reason this build cannot classify), and it carries cost and tokens,
  -- so it IS flagged. This row is what catches the inverted skip-reason arm.
  ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000d1', 'ext-5', 'claude', 'sonnet', 'inactive', 'acme/web', now() - interval '5 days', NULL, 50, 1),
  -- S6 retryable failure -> failedTransient, must not be flagged.
  ('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-0000000000d1', 'ext-6', 'claude', 'sonnet', 'inactive', 'acme/web', now() - interval '6 days', NULL, 50, 2),
  -- S7 readable but behind -> stale, must not be flagged.
  ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-0000000000d1', 'ext-7', 'claude', 'sonnet', 'inactive', 'acme/web', now() - interval '6 days', NULL, 50, 2),
  -- S8 no main transcript ROW AT ALL, with metrics -> neverExpected cohort.
  ('00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-0000000000d1', 'ext-8', 'codex', 'gpt-5.5', 'inactive', 'acme/app', now() - interval '2 days', NULL, 70, 7),
  -- S9 flagged ONLY by readable subagents, and only inside the 30d window.
  ('00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-0000000000d1', 'ext-9', 'claude', 'opus', 'inactive', 'acme/api', now() - interval '20 days', NULL, 0, 0),
  -- S10 old mixed state: only inside `all`.
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-0000000000d1', 'ext-10', 'claude', 'opus', 'inactive', 'acme/api', now() - interval '100 days', NULL, 500, 10),
  -- S11 transcript linked ONLY by the identity triple: exercises the fallback
  -- join. Its session_detail_id is left NULL below.
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-0000000000d2', 'ext-11', 'codex', 'gpt-5.5', 'inactive', 'acme/app', now() - interval '1 day', NULL, 400, 4);

-- The Owner (ISS-12251 D-1: the artifact assignee). S3 has none.
UPDATE artifacts SET assignee_id = v.assignee_id
FROM (VALUES
  ('00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid),
  ('00000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid),
  ('00000000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-8000-0000000000c2'::uuid),
  ('00000000-0000-4000-8000-000000000005'::uuid, '00000000-0000-4000-8000-0000000000c2'::uuid),
  ('00000000-0000-4000-8000-000000000006'::uuid, '00000000-0000-4000-8000-0000000000c2'::uuid),
  ('00000000-0000-4000-8000-000000000007'::uuid, '00000000-0000-4000-8000-0000000000c2'::uuid),
  ('00000000-0000-4000-8000-000000000008'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid),
  ('00000000-0000-4000-8000-000000000009'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid),
  ('00000000-0000-4000-8000-000000000010'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid),
  ('00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid)
) AS v(id, assignee_id)
WHERE artifacts.id = v.id;

INSERT INTO session_transcript (
  id, organization_id, compute_target_id, external_session_id, session_detail_id,
  file_key, upload_status, permanent_failure_reason, last_observed_at, uploaded_at
)
VALUES
  ('00000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-1', '00000000-0000-4000-8000-000000000001', 'main', 'uploaded', NULL, now() - interval '1 day', now() - interval '1 day'),
  ('00000000-0000-4000-8000-0000000f0002', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-2', '00000000-0000-4000-8000-000000000002', 'main', 'skipped', 'too_large', now() - interval '2 days', NULL),
  ('00000000-0000-4000-8000-0000000f0003', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-3', '00000000-0000-4000-8000-000000000003', 'main', 'skipped', 'source_gone', now() - interval '3 days', NULL),
  ('00000000-0000-4000-8000-0000000f0004', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-4', '00000000-0000-4000-8000-000000000004', 'main', 'skipped', 'materialized_source_unavailable', now() - interval '4 days', NULL),
  ('00000000-0000-4000-8000-0000000f0005', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-5', '00000000-0000-4000-8000-000000000005', 'main', 'skipped', NULL, now() - interval '5 days', NULL),
  ('00000000-0000-4000-8000-0000000f0006', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-6', '00000000-0000-4000-8000-000000000006', 'main', 'failed', NULL, now() - interval '6 days', NULL),
  -- S7: observed AFTER it was uploaded -> stale.
  ('00000000-0000-4000-8000-0000000f0007', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-7', '00000000-0000-4000-8000-000000000007', 'main', 'uploaded', NULL, now() - interval '1 hour', now() - interval '6 days'),
  -- S8 deliberately has NO main row. It does own a readable sidechain, which is
  -- what makes it a `neverExpected` WITH evidence rather than an empty record.
  ('00000000-0000-4000-8000-0000000f0008', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-8', '00000000-0000-4000-8000-000000000008', 'subagent:a', 'uploaded', NULL, now() - interval '2 days', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000f0009', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-9', '00000000-0000-4000-8000-000000000009', 'main', 'skipped', 'retries_exhausted', now() - interval '20 days', NULL),
  ('00000000-0000-4000-8000-0000000f000a', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-9', '00000000-0000-4000-8000-000000000009', 'subagent:a', 'uploaded', NULL, now() - interval '20 days', now() - interval '20 days'),
  ('00000000-0000-4000-8000-0000000f000b', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-9', '00000000-0000-4000-8000-000000000009', 'subagent:b', 'uploaded', NULL, now() - interval '20 days', now() - interval '20 days'),
  ('00000000-0000-4000-8000-0000000f000c', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1', 'ext-10', '00000000-0000-4000-8000-000000000010', 'main', 'skipped', 'too_large', now() - interval '100 days', NULL),
  -- S11: session_detail_id NULL on purpose — only the identity triple links it.
  ('00000000-0000-4000-8000-0000000f000d', '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d2', 'ext-11', NULL, 'main', 'skipped', 'too_large', now() - interval '1 day', NULL);

-- Trace events: S1 ten, S2 the reported 216, S4/S6 a few, S8 four, S10 five.
-- S3, S5, S7, S9 and S11 get NONE, so S3's exclusion from `cohort_derived` and
-- S9's inclusion via subagents alone are both load-bearing.
INSERT INTO agent_session_events (id, agent_session_id, external_event_id, event_created_at)
SELECT
  ('00000000-0000-4000-8000-' || lpad((100000 + s.n * 1000 + i)::text, 12, '0'))::uuid,
  ('00000000-0000-4000-8000-' || lpad(s.n::text, 12, '0'))::uuid,
  'evt-' || s.n || '-' || i,
  now() - interval '1 day'
FROM (VALUES (1, 10), (2, 216), (4, 5), (6, 3), (8, 4), (10, 5)) AS s(n, cnt),
     LATERAL generate_series(1, s.cnt) AS i;
