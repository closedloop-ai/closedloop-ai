-- ISS-12463 (PLN-2192 T-2.8): a branch's Owner is its artifact assignee,
-- seeded ONCE from the inferred Owner chain (earliest captured push's session
-- creator, then earliest commit author, then PR creator, each through the
-- org's own users) while the branch holds no assignee (operator ruling
-- 2026-10-16, option 1). The API seeds every branch it writes evidence for
-- from PR #8890 and #8916 on; this stamps every EXISTING branch whose chain
-- resolves, so the Owner readers can switch to the assignee.
--
-- HAND-WRITTEN ON PURPOSE (packages/database/AGENTS.md): a pure DATA
-- migration. No schema change, so `prisma migrate dev` has nothing to generate
-- and reports no drift.
--
-- THE CANDIDATE SET IS THE API'S OWN. The pre-flight `candidates` subquery is
-- `branchOwnerSeedCandidateSql(Prisma.sql`TRUE`)`
-- (apps/api/app/branches/branch-owner-seed/branch-owner-seed-sql.ts) rendered
-- with its bind values inlined as literals, the whole corpus as its scope. It
-- carries the list lateral's unused label and availability columns because it
-- is that render, not a transcription. Only an unassigned BRANCH whose chain
-- names a non-shadow user (`clerk_id NOT LIKE 'github-shadow:%'`) of the
-- branch's own organization is a candidate. Tombstoned branches are included,
-- as the list lateral includes them. `apps/api/app/branches/branch-owner-seed/
-- iss12463-branch-owner-backfill.integration.test.ts` executes this file and
-- pins its writes to that function over the same fixtures.
--
-- SET-IF-NULL, never an overwrite: every predicate requires `assignee_id IS
-- NULL`, so a branch a person or the live seed already assigned keeps its
-- assignee, and a re-run selects nothing the first run wrote (IDEMPOTENT).
--
-- A ROW HELD BY LIVE TRAFFIC IS SKIPPED, NOT WAITED ON. The serving API seeds
-- inside ingest and linking transactions that hold branch rows; waiting on one
-- of those risks the `lock_timeout` below and a failed deploy (the live seed
-- found a real ingest/linking deadlock this way, PR #8890 review). Every write
-- pass takes `FOR NO KEY UPDATE SKIP LOCKED` on the candidates, the same
-- discipline as `seedBranchOwners`, and its UPDATE writes only rows it locked.
-- A branch held by an ingest, linking or GitHub write is seeded by that write's
-- own seed when it commits. A branch held by any other write (a priority edit,
-- project move, rename or tombstone) is retried: after the main pass, up to
-- `retry_passes` (3) more passes run `retry_delay_seconds` (0.5 s) apart over
-- the candidates still unassigned, with the same SKIP LOCKED write; they run
-- only while some candidate is still unassigned. A branch held through every
-- pass stays unassigned until its next evidence write seeds it, and until then
-- reads as Unattributed once Owner reads the assignee. The NOTICE reports how
-- many were seeded, how many of those on a retry pass, how many were held
-- through every pass, and how many another write assigned meanwhile. After the
-- deploy, the exact-count query below lists what is still unseeded; run the
-- drain under RECOVERY to seed it.
--
-- `updated_at` IS NOT BUMPED. `artifacts.updated_at` is written by the
-- application (Prisma `@updatedAt`), with no database default or trigger, so
-- an UPDATE that does not name it leaves it alone. No activity receipt and no
-- assignment notification are written (PLN-2192 AC-006).
--
-- POPULATION NOT MEASURED AGAINST PRODUCTION. Authored in a lane with no
-- production access. This runs inside the api-prod build's `prisma migrate
-- deploy`, so its whole duration is deploy time. READ THE COUNT AND THE PLAN
-- BEFORE DEPLOYING; a fired ceiling is a FAILED deploy for everyone, not a
-- skipped repair. The upper bound (every unassigned branch, before the chain
-- is resolved):
--
--   SELECT count(*)
--     FROM "artifacts" AS a
--     JOIN "branch_detail" AS b ON b."artifact_id" = a."id"
--    WHERE a."type" = 'BRANCH'::"ArtifactType"
--      AND a."assignee_id" IS NULL;
--
-- The exact count is `SELECT count(*) FROM (<the candidates subquery body>)
-- c`. Then run `EXPLAIN (ANALYZE, BUFFERS) <the candidates subquery body>`
-- (read-only: it runs the SELECT, writes nothing, takes no row locks): the
-- body evaluates the Owner lateral, roughly six correlated subqueries over
-- artifact_links and session rows plus a commit and a PR lookup, once for
-- EVERY unassigned branch, not only for the ones that become candidates, and
-- no estimate below covers that time.
--
-- TWO PHASES, NO ROW LOCK DURING THE EXPENSIVE ONE. The PRE-FLIGHT evaluates
-- the candidate subquery once, capped at `max_inline_rows + 1`, into two
-- arrays of (branch id, owner user id) with a plain SELECT: no row locks, only
-- the ACCESS SHARE every read takes. If it holds more than `max_inline_rows`
-- the block raises right there, before any write. The WRITE PHASE then locks
-- only those ids, re-states `type` and `assignee_id IS NULL` against its own
-- target so READ COMMITTED re-evaluates them against a row a concurrent writer
-- has changed since the pre-flight, and stamps the user the pre-flight chose.
-- Each pass is its own statement, so each reads a fresh snapshot.
--
-- THE CEILING: 250,000 rows. ~72 s is the WRITE PHASE alone at the ceiling, at
-- the ~3,450 rows/s ISS-8517 measured for a single-column UPDATE on
-- laptop-class Postgres 16; it excludes the pre-flight (measure it with the
-- EXPLAIN ANALYZE above). This is a data write: ROW EXCLUSIVE plus a row lock
-- on every row it stamps, held from that row's write until the migration's
-- transaction commits. So a row's lock window is the rest of the write phase:
-- the main UPDATE, plus, only when a candidate was skipped, up to 3 retry
-- passes and their 0.5 s sleeps (at most 1.5 s of sleep). A live transaction
-- that touches a stamped branch without SKIP LOCKED waits for that window.
--
-- RECOVERY, if the ceiling fires: `prisma migrate resolve --rolled-back
-- 20261019182000_iss12463_branch_owner_backfill`, then run the DO block below
-- on its own (each run its own transaction), with `max_inline_rows CONSTANT
-- bigint := 10000` and its `IF owners_selected > max_inline_rows THEN ... END
-- IF;` ceiling block deleted, so each run stamps up to 10,001 branches, until
-- its NOTICE reports 0 selected; then re-run the deploy. The same drain seeds
-- any branch a deployed run left held through every pass.
--
-- IRREVERSIBLE from data alone in principle, but nothing else wrote a branch
-- assignee before ISS-12463, so the reverse is `UPDATE "artifacts" SET
-- "assignee_id" = NULL WHERE "type" = 'BRANCH'`, which also clears the live
-- seed's stamps. FORWARD-ONLY.

SET lock_timeout = '5s';

DO $iss12463$
DECLARE
  max_inline_rows CONSTANT bigint := 250000;
  retry_passes CONSTANT int := 3;
  retry_delay_seconds CONSTANT double precision := 0.5;
  candidate_ids uuid[];
  candidate_users uuid[];
  owners_selected bigint;
  owners_written bigint := 0;
  owners_retried bigint := 0;
  owners_pending bigint;
  pass_written bigint;
BEGIN
  SELECT array_agg(c.id ORDER BY c.id), array_agg(c.user_id ORDER BY c.id)
    INTO candidate_ids, candidate_users
    FROM (
      SELECT a.id, u.id AS user_id
      FROM artifacts a
      JOIN branch_detail b ON b.artifact_id = a.id AND b.organization_id = a.organization_id
      LEFT JOIN LATERAL (
        SELECT
          observed_push.owner_key AS observed_owner_key,
          observed_push.owner_label AS observed_owner_label,
          observed_push.owner_availability AS observed_owner_availability,
          COALESCE(observed_push.owner_key, inferred.owner_key) AS owner_key,
          COALESCE(observed_push.owner_label, inferred.owner_label) AS owner_label,
          CASE
            WHEN observed_push.owner_key IS NULL AND inferred.owner_key IS NOT NULL
              THEN 'incomplete'::text
            ELSE observed_push.owner_availability
          END AS owner_availability
        FROM (
      SELECT
        (
          array_agg((
      CASE
        WHEN gc.user_id IS NOT NULL OR u.id IS NOT NULL
          THEN ('closedloop'::text || ':' || session_artifact.created_by_id::text)
      END
    ) ORDER BY (
      CASE
        WHEN gc.user_id IS NOT NULL OR u.id IS NOT NULL
          THEN ('closedloop'::text || ':' || session_artifact.created_by_id::text)
      END
    ) COLLATE "und-x-icu")
            FILTER (WHERE (
      CASE
        WHEN gc.user_id IS NOT NULL OR u.id IS NOT NULL
          THEN ('closedloop'::text || ':' || session_artifact.created_by_id::text)
      END
    ) IS NOT NULL)
        )[1] AS owner_key,
        (
          array_agg(COALESCE(COALESCE(NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email), gc.login) ORDER BY (
      CASE
        WHEN gc.user_id IS NOT NULL OR u.id IS NOT NULL
          THEN ('closedloop'::text || ':' || session_artifact.created_by_id::text)
      END
    ) COLLATE "und-x-icu")
            FILTER (WHERE (
      CASE
        WHEN gc.user_id IS NOT NULL OR u.id IS NOT NULL
          THEN ('closedloop'::text || ':' || session_artifact.created_by_id::text)
      END
    ) IS NOT NULL)
        )[1] AS owner_label,
        (
      CASE
        WHEN b.first_pushed_at IS NULL AND (
      SELECT count(*)
      FROM artifact_links al
      INNER JOIN artifacts session_artifact
        ON session_artifact.id = al.source_id
      INNER JOIN session_detail sd
        ON sd.artifact_id = session_artifact.id
      WHERE (
      al.organization_id = a.organization_id
      AND al.target_id = a.id
      AND (al.branch_participation IS NULL OR al.branch_participation IN ('wrote', 'reviewed'))
      AND al.link_type = 'RELATES_TO'::"LinkType"
      AND session_artifact.organization_id = a.organization_id
      AND session_artifact.type = 'SESSION'::"ArtifactType"
      AND (
        al.metadata ->> 'linkKind' IN (
          'session_pr',
          'session_branch'
        )
        OR al.metadata -> 'linkKinds' @> '["session_pr_set"]'::jsonb
      )
    )
        AND al.branch_participation_method IN ('git_push','gh_pr_create')
    ) = 0
          THEN 'complete'::text
        WHEN count((
      CASE
        WHEN gc.user_id IS NOT NULL OR u.id IS NOT NULL
          THEN ('closedloop'::text || ':' || session_artifact.created_by_id::text)
      END
    )) > 0
          AND count((
      CASE
        WHEN gc.user_id IS NOT NULL OR u.id IS NOT NULL
          THEN ('closedloop'::text || ':' || session_artifact.created_by_id::text)
      END
    )) = count(*)
          AND (
      b.first_pushed_at IS NOT NULL
      OR (
      SELECT count(*)
      FROM artifact_links al
      INNER JOIN artifacts session_artifact
        ON session_artifact.id = al.source_id
      INNER JOIN session_detail sd
        ON sd.artifact_id = session_artifact.id
      WHERE (
      al.organization_id = a.organization_id
      AND al.target_id = a.id
      AND (al.branch_participation IS NULL OR al.branch_participation IN ('wrote', 'reviewed'))
      AND al.link_type = 'RELATES_TO'::"LinkType"
      AND session_artifact.organization_id = a.organization_id
      AND session_artifact.type = 'SESSION'::"ArtifactType"
      AND (
        al.metadata ->> 'linkKind' IN (
          'session_pr',
          'session_branch'
        )
        OR al.metadata -> 'linkKinds' @> '["session_pr_set"]'::jsonb
      )
    )
        AND al.branch_participation_method IN ('git_push','gh_pr_create')
    ) = (
      SELECT count(*)
      FROM artifact_links al
      INNER JOIN artifacts session_artifact
        ON session_artifact.id = al.source_id
      INNER JOIN session_detail sd
        ON sd.artifact_id = session_artifact.id
      WHERE (
      al.organization_id = a.organization_id
      AND al.target_id = a.id
      AND (al.branch_participation IS NULL OR al.branch_participation IN ('wrote', 'reviewed'))
      AND al.link_type = 'RELATES_TO'::"LinkType"
      AND session_artifact.organization_id = a.organization_id
      AND session_artifact.type = 'SESSION'::"ArtifactType"
      AND (
        al.metadata ->> 'linkKind' IN (
          'session_pr',
          'session_branch'
        )
        OR al.metadata -> 'linkKinds' @> '["session_pr_set"]'::jsonb
      )
    )
        AND al.branch_participation_method IN ('git_push','gh_pr_create')
        AND al.branch_participation_observed_at IS NOT NULL
    )
    )
          THEN 'complete'::text
        ELSE 'incomplete'::text
      END
    ) AS owner_availability
      FROM artifact_links al
      INNER JOIN artifacts session_artifact
        ON session_artifact.id = al.source_id
      INNER JOIN session_detail sd
        ON sd.artifact_id = session_artifact.id
      LEFT JOIN github_user_connections gc
        ON gc.organization_id = a.organization_id
        AND gc.user_id = session_artifact.created_by_id
      LEFT JOIN users u
        ON u.organization_id = a.organization_id
        AND u.id = session_artifact.created_by_id
      WHERE (
      al.organization_id = a.organization_id
      AND al.target_id = a.id
      AND (al.branch_participation IS NULL OR al.branch_participation IN ('wrote', 'reviewed'))
      AND al.link_type = 'RELATES_TO'::"LinkType"
      AND session_artifact.organization_id = a.organization_id
      AND session_artifact.type = 'SESSION'::"ArtifactType"
      AND (
        al.metadata ->> 'linkKind' IN (
          'session_pr',
          'session_branch'
        )
        OR al.metadata -> 'linkKinds' @> '["session_pr_set"]'::jsonb
      )
    )
        AND al.branch_participation_method IN ('git_push','gh_pr_create')
        AND al.branch_participation_observed_at IS NOT NULL
        AND (
      (
      SELECT count(*)
      FROM artifact_links al
      INNER JOIN artifacts session_artifact
        ON session_artifact.id = al.source_id
      INNER JOIN session_detail sd
        ON sd.artifact_id = session_artifact.id
      WHERE (
      al.organization_id = a.organization_id
      AND al.target_id = a.id
      AND (al.branch_participation IS NULL OR al.branch_participation IN ('wrote', 'reviewed'))
      AND al.link_type = 'RELATES_TO'::"LinkType"
      AND session_artifact.organization_id = a.organization_id
      AND session_artifact.type = 'SESSION'::"ArtifactType"
      AND (
        al.metadata ->> 'linkKind' IN (
          'session_pr',
          'session_branch'
        )
        OR al.metadata -> 'linkKinds' @> '["session_pr_set"]'::jsonb
      )
    )
        AND al.branch_participation_method IN ('git_push','gh_pr_create')
        AND al.branch_participation_observed_at IS NOT NULL
    ) <= 1
      OR al.branch_participation_observed_at = COALESCE(
        b.first_pushed_at,
        (
      SELECT min(al.branch_participation_observed_at)
      FROM artifact_links al
      INNER JOIN artifacts session_artifact
        ON session_artifact.id = al.source_id
      INNER JOIN session_detail sd
        ON sd.artifact_id = session_artifact.id
      WHERE (
      al.organization_id = a.organization_id
      AND al.target_id = a.id
      AND (al.branch_participation IS NULL OR al.branch_participation IN ('wrote', 'reviewed'))
      AND al.link_type = 'RELATES_TO'::"LinkType"
      AND session_artifact.organization_id = a.organization_id
      AND session_artifact.type = 'SESSION'::"ArtifactType"
      AND (
        al.metadata ->> 'linkKind' IN (
          'session_pr',
          'session_branch'
        )
        OR al.metadata -> 'linkKinds' @> '["session_pr_set"]'::jsonb
      )
    )
        AND al.branch_participation_method IN ('git_push','gh_pr_create')
        AND al.branch_participation_observed_at IS NOT NULL
    )
      )
    )
    ) observed_push
        LEFT JOIN LATERAL (
      SELECT
        inferred_candidate.person_key AS owner_key,
        inferred_candidate.person_label AS owner_label
      FROM (
        (
      SELECT
      1::int AS rung,
      ('closedloop'::text || ':' || gc.user_id::text) AS person_key,
      COALESCE(COALESCE(NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email), gc.login) AS person_label
      FROM (
        SELECT commits.author_login
        FROM commit_detail commits
        WHERE commits.branch_artifact_id = a.id
          AND commits.author_login IS NOT NULL
          AND commits.author_login <> ''
        ORDER BY commits.committed_at ASC NULLS LAST, commits.sha ASC
        LIMIT 1
      ) earliest_commit
      INNER JOIN github_user_connections gc
        ON gc.organization_id = a.organization_id
        AND gc.login = earliest_commit.author_login
      LEFT JOIN users u
        ON u.organization_id = a.organization_id
        AND u.id = gc.user_id
    )
        UNION ALL
        (
      SELECT
      2::int AS rung,
      ('closedloop'::text || ':' || gc.user_id::text) AS person_key,
      COALESCE(COALESCE(NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email), gc.login) AS person_label
      FROM pull_request_detail pr
      INNER JOIN github_user_connections gc
        ON gc.organization_id = a.organization_id
        AND gc.login = pr.author_login
      LEFT JOIN users u
        ON u.organization_id = a.organization_id
        AND u.id = gc.user_id
      WHERE pr.organization_id = a.organization_id
        AND pr.branch_artifact_id = a.id
        AND pr.author_login IS NOT NULL
        AND pr.author_login <> ''
      ORDER BY
        pr.repository_full_name ASC,
        pr.repository_id ASC,
        pr.number ASC,
        pr.id ASC
      LIMIT 1
    )
      ) inferred_candidate
      ORDER BY inferred_candidate.rung ASC, inferred_candidate.person_key ASC
      LIMIT 1
    ) inferred
          ON observed_push.owner_key IS NULL
      ) branch_owner_identity ON TRUE
      JOIN users u
        ON u.organization_id = a.organization_id
        AND u.id = CASE
          WHEN starts_with(branch_owner_identity.owner_key, 'closedloop:')
            THEN split_part(branch_owner_identity.owner_key, ':', 2)::uuid
        END
        AND u.clerk_id NOT LIKE 'github-shadow:%'
      WHERE a.type = 'BRANCH'::"ArtifactType"
        AND a.assignee_id IS NULL
     LIMIT max_inline_rows + 1
    ) AS c;
  owners_selected := COALESCE(cardinality(candidate_ids), 0);

  IF owners_selected > max_inline_rows THEN
    RAISE EXCEPTION
      'ISS-12463 (branch Owner to assignee): more than % BRANCH artifacts still need their assignee seeded from the Owner chain; refusing to rewrite them in one transaction. Recover: run `prisma migrate resolve --rolled-back 20261019182000_iss12463_branch_owner_backfill`, then the drain described in that migration''s header until it reports 0, then re-run the deploy.',
      max_inline_rows
      USING HINT =
        'This migration is now recorded as failed and stands alone. It raised before writing anything. The three recovery steps are in the message above; the drain is described in the migration header.';
  END IF;

  owners_pending := owners_selected;
  FOR pass IN 0..retry_passes LOOP
    EXIT WHEN owners_pending = 0;
    IF pass > 0 THEN
      PERFORM pg_sleep(retry_delay_seconds);
    END IF;

    WITH locked AS MATERIALIZED (
      SELECT l."id"
        FROM "artifacts" AS l
       WHERE l."id" = ANY (candidate_ids)
         AND l."type" = 'BRANCH'::"ArtifactType"
         AND l."assignee_id" IS NULL
         FOR NO KEY UPDATE SKIP LOCKED
    ), stamped AS (
      UPDATE "artifacts" AS t
         SET "assignee_id" = s."user_id"
        FROM unnest(candidate_ids, candidate_users) AS s("id", "user_id")
       WHERE t."id" = s."id"
         AND t."id" IN (SELECT k."id" FROM locked AS k)
         AND t."type" = 'BRANCH'::"ArtifactType"
         AND t."assignee_id" IS NULL
      RETURNING t."id"
    )
    SELECT count(*) INTO pass_written FROM stamped;

    owners_written := owners_written + pass_written;
    IF pass > 0 THEN
      owners_retried := owners_retried + pass_written;
    END IF;

    SELECT count(*)
      INTO owners_pending
      FROM "artifacts" AS p
     WHERE p."id" = ANY (candidate_ids)
       AND p."type" = 'BRANCH'::"ArtifactType"
       AND p."assignee_id" IS NULL;
  END LOOP;

  RAISE NOTICE 'ISS-12463: seeded % of % selected branches (% on retry passes); % held by a live write through every pass and skipped; % assigned or changed by another write meanwhile.',
    owners_written, owners_selected, owners_retried, owners_pending,
    owners_selected - owners_written - owners_pending;
END
$iss12463$;

RESET lock_timeout;
