-- ISS-8487 — a throwaway fixture that EXERCISES
-- `iss-8487-analytics-population-movement.sql` so its cohort rules can be
-- checked without production access.
--
-- This file CREATEs and DROPs tables. It refuses to run against anything but
-- the throwaway database the recipe below builds — see FIXTURE_DATABASE at the
-- bottom of this header. It builds the narrow slice of the schema the audit
-- reads (the columns, names and types the audit references — not the full
-- models) plus fifteen sessions chosen so that every arm of both folds is hit,
-- both cohort predicates are hit, and at least one row would move if any single
-- rule were widened or narrowed.
--
--   docker run -d --name iss8487-pg -e POSTGRES_PASSWORD=pg -e POSTGRES_USER=pg \
--     -e POSTGRES_DB=iss8487 -p 58487:5432 postgres:16
--   psql "postgres://pg:pg@127.0.0.1:58487/iss8487" -f iss-8487-analytics-population-movement.fixture.sql
--   psql "postgres://pg:pg@127.0.0.1:58487/iss8487" -f iss-8487-analytics-population-movement.sql
--
-- EXPECTED, derived by hand from the fold rules rather than from a previous run
-- of the audit (a fixture read off its own subject proves nothing). The cutover
-- is 2026-08-19, so `1_pre_30d` is [2026-07-20, 2026-08-19) and `2_post_30d` is
-- [2026-08-19, 2026-09-18).
--
--   section 1   denom  moved  moved_min  moved_usd  err->unk
--   1_pre_30d     12      6      260.0      29.00       1
--   2_post_30d     2      2      135.0      23.00       0
--   3_all         15      9      440.0      54.50       1
--
--   section 2 over 3_all:
--     clean   -> unknown  9   (S2 S3 S4 S9 S11 S12 S13 S14 S15)
--     clean   -> clean    2   (S1 S10)
--     unknown -> unknown  2   (S7 S8)
--     errored -> unknown  1   (S5)
--     errored -> errored  1   (S6)                             = 15
--
--   section 3   moved  newly_lost  newly_lost_min  newly_lost_usd
--   1_pre_30d     6        3            180.0           18.00
--   2_post_30d    2        2            135.0           23.00
--   3_all         9        6            360.0           43.50
--
--   section 4 over 1_pre_30d: active 5, waiting 1  (S9 is the `waiting` row)
--
--   section 5   state_not_null over 3_all = 2  (S8 RUNNING, S10 COMPLETED)
--
-- THE ROWS, and the rule each one pins:
--
--   S1  inactive / false / state NULL      clean -> clean. The gate is terminal
--                                          both ways; nothing moves.
--   S2  active   / false / state NULL      THE HEADLINE. Clean -> Unknown, no
--                                          artifact, 60 min -> newly lost.
--   S3  active   / false / state NULL      Moved, but produced a PR, so NOT
--                                          newly lost. Also carries TWO usage
--                                          rows (two models): if the spend
--                                          pre-aggregation were a bare join it
--                                          would count this session twice.
--   S4  active   / false / state NULL      Moved, but zero wall-clock (ended ==
--                                          started), so NOT newly lost. Has no
--                                          usage row at all, so it also pins
--                                          the LEFT join's zero.
--   S5  active   / true  / state NULL      Errored -> Unknown. The SECOND
--                                          movement; must not land in the AC1
--                                          headline.
--   S6  error    / true  / state NULL      Errored -> Errored. Terminal both
--                                          ways.
--   S7  inactive / NULL  / state NULL      Unknown -> Unknown. ends_with_error
--                                          null was already Unknown.
--   S8  active   / false / state RUNNING   Unknown -> Unknown. The OLD gate
--                                          fired for this row, so it did NOT
--                                          move. Drop the `state` term from the
--                                          BEFORE fold and this becomes a false
--                                          sixth mover in pre_30d.
--   S9  waiting  / false / state NULL      Moved. `waiting` is a display-only
--                                          word; normalizeSessionStatus folds it
--                                          to `active`, which is NOT terminal.
--                                          Add `waiting` to the AFTER terminal
--                                          list and this stops moving.
--   S10 inactive / false / state COMPLETED clean -> clean. `COMPLETED` is in the
--                                          BEFORE terminal set. Drop it from
--                                          that list and S10 reads
--                                          Unknown -> Clean, inventing a
--                                          backwards move.
--   S11 active   / false / state NULL      The only post-cutover row, and the
--                                          only one with session_ended_at NULL:
--                                          its 120 minutes come from the
--                                          `last_activity_at` fallback rung.
--   S12 active   / false / state NULL      Outside both 30-day windows, so it
--                                          appears in `3_all` only — the
--                                          movement is not confined to
--                                          post-cutover sessions.
--   S13 active   / false / state NULL      Starts at EXACTLY the cutover
--                                          instant, which is `pre_30d.until`
--                                          and `post_30d.since` at once. The
--                                          only row that pins the windows as
--                                          half-open: flip `< w.until` to
--                                          `<= w.until` and S13 is counted in
--                                          BOTH 30-day windows, taking
--                                          `1_pre_30d` to 13 sessions and 7
--                                          movers. No other row sits on a
--                                          boundary, so without S13 the closed,
--                                          half-open and open-closed
--                                          conventions all print the same
--                                          table.
--   S14 active   / false / state NULL      Moved, no PR, 50 min — so it WOULD
--                                          be newly lost — but `files_changed`
--                                          is 2. The only row that pins the
--                                          `files_changed` arm of
--                                          `PRODUCED_ARTIFACT`: drop
--                                          `OR COALESCE(files_changed, 0) > 0`
--                                          and S14 becomes a fourth newly-lost
--                                          session in `1_pre_30d`
--                                          (180.0 -> 230.0 min, 18.00 ->
--                                          24.00). Every OTHER row carrying a
--                                          non-zero `files_changed` (S1, S10)
--                                          is clean -> clean and never reaches
--                                          section 3.
--   S15 active   / false / state NULL      Moved, newly lost, and the only row
--                                          whose `pull_requests` is a JSON
--                                          OBJECT rather than an array or NULL.
--                                          It pins the `ELSE false` arm of the
--                                          `CASE` in `PRODUCED_ARTIFACT` on a
--                                          non-array value. It does NOT pin
--                                          `CASE` against the `AND` spelling —
--                                          measured on postgres 16.15, the
--                                          planner short-circuits
--                                          `false AND jsonb_array_length(…)`
--                                          and no error is raised on an object.
--                                          The rows that DO separate the two
--                                          spellings are the NULL ones (S9 S11
--                                          S12 S13): see the audit's
--                                          `PRODUCED_ARTIFACT` comment. Swap the
--                                          `CASE` for `AND` and section 3 reads
--                                          2 / 0 / 2 instead of 3 / 2 / 6.

\set ON_ERROR_STOP on

-- FIXTURE_DATABASE — the throwaway database this file is allowed to touch, and
-- the one the `docker run` recipe above creates. The guard below is the whole
-- reason a mistyped connection string is survivable: without it, pointing this
-- at a DDL-capable production URL drops `artifacts`, `session_detail` and
-- `agent_session_token_usage` before any warning in a comment can help. Change
-- this literal if you build the scratch database under another name.
DO $$
BEGIN
  IF current_database() <> 'iss8487' THEN
    RAISE EXCEPTION
      'REFUSING TO RUN: this fixture DROPs and CREATEs tables and is only for the throwaway database "iss8487" (connected to "%"). Create it with the docker recipe in this file''s header, or edit FIXTURE_DATABASE.',
      current_database();
  END IF;
END
$$;

DROP TABLE IF EXISTS agent_session_token_usage, session_detail, artifacts CASCADE;

CREATE TABLE artifacts (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  type            text NOT NULL,
  status          text NOT NULL
);

CREATE TABLE session_detail (
  artifact_id        uuid PRIMARY KEY REFERENCES artifacts(id),
  state              text,
  ends_with_error    boolean,
  pull_requests      jsonb,
  files_changed      int,
  session_started_at timestamp NOT NULL,
  session_ended_at   timestamp,
  last_activity_at   timestamp NOT NULL
);

CREATE TABLE agent_session_token_usage (
  id              uuid PRIMARY KEY,
  agent_session_id uuid NOT NULL REFERENCES session_detail(artifact_id),
  model           text NOT NULL,
  estimated_cost  numeric(14, 6) NOT NULL DEFAULT 0
);

INSERT INTO artifacts (id, organization_id, type, status) VALUES
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'inactive'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'active'),
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'active'),
  ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'active'),
  ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'active'),
  ('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'error'),
  ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'inactive'),
  ('00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'active'),
  ('00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'waiting'),
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'inactive'),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'active'),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'active'),
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'active'),
  ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'active'),
  ('00000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-0000000000aa', 'SESSION', 'active');

-- `last_activity_at` is NOT NULL in the real schema and the audit's fallback
-- rung reads it, so every row carries one. It equals `session_ended_at`
-- wherever an end was recorded; S11 is the one row where it is the only span
-- source.
INSERT INTO session_detail
  (artifact_id, state, ends_with_error, pull_requests, files_changed,
   session_started_at, session_ended_at, last_activity_at) VALUES
  -- S1: clean -> clean, 15 min.
  ('00000000-0000-4000-8000-000000000001', NULL, false, NULL, 3,
   '2026-08-01 10:00', '2026-08-01 10:15', '2026-08-01 10:15'),
  -- S2: THE HEADLINE. clean -> unknown, no artifact, 60 min -> newly lost.
  ('00000000-0000-4000-8000-000000000002', NULL, false, '[]'::jsonb, 0,
   '2026-08-02 10:00', '2026-08-02 11:00', '2026-08-02 11:00'),
  -- S3: moved, produced a PR, 30 min -> NOT newly lost. Two usage rows below.
  ('00000000-0000-4000-8000-000000000003', NULL, false, '[{"number": 1}]'::jsonb, 0,
   '2026-08-03 10:00', '2026-08-03 10:30', '2026-08-03 10:30'),
  -- S4: moved, zero wall-clock -> NOT newly lost. No usage row at all.
  ('00000000-0000-4000-8000-000000000004', NULL, false, NULL, NULL,
   '2026-08-04 10:00', '2026-08-04 10:00', '2026-08-04 10:00'),
  -- S5: errored -> unknown, 20 min.
  ('00000000-0000-4000-8000-000000000005', NULL, true, NULL, 0,
   '2026-08-05 10:00', '2026-08-05 10:20', '2026-08-05 10:20'),
  -- S6: errored -> errored, 25 min.
  ('00000000-0000-4000-8000-000000000006', NULL, true, NULL, 0,
   '2026-08-06 10:00', '2026-08-06 10:25', '2026-08-06 10:25'),
  -- S7: unknown -> unknown (ends_with_error null), 10 min.
  ('00000000-0000-4000-8000-000000000007', NULL, NULL, NULL, 0,
   '2026-08-07 10:00', '2026-08-07 10:10', '2026-08-07 10:10'),
  -- S8: the OLD gate fired. unknown -> unknown, 40 min. Not a mover.
  ('00000000-0000-4000-8000-000000000008', 'RUNNING', false, NULL, 0,
   '2026-08-08 10:00', '2026-08-08 10:40', '2026-08-08 10:40'),
  -- S9: stored `waiting`. clean -> unknown, no artifact, 90 min -> newly lost.
  ('00000000-0000-4000-8000-000000000009', NULL, false, NULL, 0,
   '2026-08-09 10:00', '2026-08-09 11:30', '2026-08-09 11:30'),
  -- S10: `COMPLETED` is terminal in the BEFORE set. clean -> clean, 5 min.
  ('00000000-0000-4000-8000-000000000010', 'COMPLETED', false, NULL, 1,
   '2026-08-10 10:00', '2026-08-10 10:05', '2026-08-10 10:05'),
  -- S11: post-cutover, no recorded end. 120 min from last_activity_at.
  ('00000000-0000-4000-8000-000000000011', NULL, false, NULL, 0,
   '2026-09-01 10:00', NULL, '2026-09-01 12:00'),
  -- S12: outside both 30-day windows. 45 min, no artifact -> newly lost in all.
  ('00000000-0000-4000-8000-000000000012', NULL, false, NULL, 0,
   '2026-06-01 10:00', '2026-06-01 10:45', '2026-06-01 10:45'),
  -- S13: starts ON the cutover instant. 15 min, no artifact -> newly lost.
  ('00000000-0000-4000-8000-000000000013', NULL, false, NULL, 0,
   '2026-08-19 00:00', '2026-08-19 00:15', '2026-08-19 00:15'),
  -- S14: moved, no PR, 50 min, but files_changed = 2 -> NOT newly lost. The
  -- only row the `files_changed` arm of PRODUCED_ARTIFACT decides.
  ('00000000-0000-4000-8000-000000000014', NULL, false, NULL, 2,
   '2026-08-11 10:00', '2026-08-11 10:50', '2026-08-11 10:50'),
  -- S15: moved, newly lost, and `pull_requests` is an OBJECT, not an array.
  -- The only row the `CASE` guard in PRODUCED_ARTIFACT decides.
  ('00000000-0000-4000-8000-000000000015', NULL, false, '{"number": 7}'::jsonb, 0,
   '2026-08-12 10:00', '2026-08-12 10:30', '2026-08-12 10:30');

INSERT INTO agent_session_token_usage (id, agent_session_id, model, estimated_cost) VALUES
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-000000000001', 'sonnet', 7.00),
  ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-000000000002', 'sonnet', 10.00),
  -- S3 spans two models: one session, two rows.
  ('00000000-0000-4000-8000-0000000000f3', '00000000-0000-4000-8000-000000000003', 'sonnet', 3.00),
  ('00000000-0000-4000-8000-0000000000f4', '00000000-0000-4000-8000-000000000003', 'opus', 2.00),
  -- S4 deliberately has no usage row.
  ('00000000-0000-4000-8000-0000000000f5', '00000000-0000-4000-8000-000000000005', 'sonnet', 6.00),
  ('00000000-0000-4000-8000-0000000000f6', '00000000-0000-4000-8000-000000000006', 'sonnet', 8.00),
  ('00000000-0000-4000-8000-0000000000f7', '00000000-0000-4000-8000-000000000007', 'sonnet', 1.00),
  ('00000000-0000-4000-8000-0000000000f8', '00000000-0000-4000-8000-000000000008', 'sonnet', 9.00),
  ('00000000-0000-4000-8000-0000000000f9', '00000000-0000-4000-8000-000000000009', 'sonnet', 4.00),
  ('00000000-0000-4000-8000-0000000000fa', '00000000-0000-4000-8000-000000000010', 'sonnet', 5.00),
  ('00000000-0000-4000-8000-0000000000fb', '00000000-0000-4000-8000-000000000011', 'sonnet', 20.00),
  ('00000000-0000-4000-8000-0000000000fc', '00000000-0000-4000-8000-000000000012', 'sonnet', 2.50),
  ('00000000-0000-4000-8000-0000000000fd', '00000000-0000-4000-8000-000000000013', 'sonnet', 3.00),
  ('00000000-0000-4000-8000-0000000000fe', '00000000-0000-4000-8000-000000000014', 'sonnet', 6.00),
  ('00000000-0000-4000-8000-0000000000ff', '00000000-0000-4000-8000-000000000015', 'sonnet', 4.00);
