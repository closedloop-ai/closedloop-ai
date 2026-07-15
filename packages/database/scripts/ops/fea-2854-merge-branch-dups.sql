-- FEA-2854 — dedup branch-identity groups (TRANSACTIONAL, dry-run by default).
--
-- Unwedges prod migration 20260709210000_branch_identity_d2_key_and_push_state.
-- The migration's D2 key (organization_id, repository_full_name, branch_name)
-- collapses branch_detail rows the old (repository_id, branch_name) key kept
-- distinct — duplicate rows for ONE logical branch created by a GitHub App
-- re-install (a second installation-repo surrogate id for the same repo).
--
-- Survivor policy (PLN-1099 author decision, PR #2415): keep the row with the
-- most recent artifacts.updated_at; the branch's split history across the other
-- row(s) is not important and is dropped with them. Identity self-heals — the
-- surviving row adopts the active installation-repo id on the next webhook/sync
-- via upsertBranchArtifact (branch-service.ts L753-758), so which row survives
-- does not affect identity. This is a one-time, run-once repair.
--
-- The loser's structural artifact_links are repointed to the survivor (deduped on
-- the unique (source_id, target_id, link_type)) so we do not orphan another
-- artifact's relationship edge; everything else on the loser cascade-deletes.
--
-- USAGE — rehearse against a prod-snapshot copy first (stage has no dupes):
--   Dry run (default; rolls back, prints what it WOULD do):
--     psql "$DATABASE_URL" -f fea-2854-merge-branch-dups.sql
--   Apply (COMMITs) — only after review + approval:
--     psql "$DATABASE_URL" -v apply=true -f fea-2854-merge-branch-dups.sql
-- After a successful apply against prod:
--   prisma migrate resolve --rolled-back 20260709210000_branch_identity_d2_key_and_push_state
--   then redeploy api-prod.

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply false
\endif

BEGIN;

-- 1) Reproduce the migration's grouping; capture recency + soft-delete state.
CREATE TEMP TABLE _fea2854_rows ON COMMIT DROP AS
WITH keyed AS (
  SELECT
    bd.artifact_id,
    a.organization_id                                          AS org_id,
    lower(regexp_replace(btrim(gir.full_name), '\.git$', ''))  AS repo_full_name,
    bd.branch_name,
    a.updated_at,
    a.created_at,
    (bd.deleted_at IS NULL)                                     AS is_live
  FROM branch_detail bd
  JOIN artifacts a ON a.id = bd.artifact_id
  JOIN github_installation_repositories gir ON gir.id = bd.repository_id
),
dups AS (
  SELECT org_id, repo_full_name, branch_name
  FROM keyed GROUP BY org_id, repo_full_name, branch_name HAVING count(*) > 1
)
SELECT k.* FROM keyed k JOIN dups d USING (org_id, repo_full_name, branch_name);

-- 2) Survivor per group: most recently updated wins (then newest, then id).
CREATE TEMP TABLE _fea2854_map ON COMMIT DROP AS
SELECT r.artifact_id AS loser_id, s.survivor_id
FROM _fea2854_rows r
JOIN (
  SELECT DISTINCT ON (org_id, repo_full_name, branch_name)
    org_id, repo_full_name, branch_name, artifact_id AS survivor_id
  FROM _fea2854_rows
  ORDER BY org_id, repo_full_name, branch_name,
           updated_at DESC, created_at DESC, artifact_id DESC
) s USING (org_id, repo_full_name, branch_name)
WHERE r.artifact_id <> s.survivor_id;

-- Report what will be kept vs removed (visible in dry-run and apply).
SELECT count(*) AS losers_to_delete FROM _fea2854_map;
SELECT r.repo_full_name, r.branch_name,
       m.survivor_id, sv.updated_at AS survivor_updated_at, sv.is_live AS survivor_live,
       m.loser_id,   r.updated_at  AS loser_updated_at,   r.is_live  AS loser_live
FROM _fea2854_map m
JOIN _fea2854_rows r  ON r.artifact_id = m.loser_id
JOIN _fea2854_rows sv ON sv.artifact_id = m.survivor_id
ORDER BY r.repo_full_name, r.branch_name;

-- 3) Repoint the loser's structural artifact_links onto the survivor, deduping on
--    the unique (source_id, target_id, link_type). Delete would-be duplicates and
--    survivor<->loser self-links first, then move the remainder.
DELETE FROM artifact_links al USING _fea2854_map m
WHERE al.source_id = m.loser_id
  AND EXISTS (SELECT 1 FROM artifact_links s WHERE s.source_id = m.survivor_id AND s.target_id = al.target_id AND s.link_type = al.link_type);
DELETE FROM artifact_links al USING _fea2854_map m
WHERE al.target_id = m.loser_id
  AND EXISTS (SELECT 1 FROM artifact_links s WHERE s.target_id = m.survivor_id AND s.source_id = al.source_id AND s.link_type = al.link_type);
DELETE FROM artifact_links al USING _fea2854_map m
WHERE (al.source_id = m.loser_id AND al.target_id = m.survivor_id)
   OR (al.target_id = m.loser_id AND al.source_id = m.survivor_id);
UPDATE artifact_links al SET source_id = m.survivor_id FROM _fea2854_map m WHERE al.source_id = m.loser_id;
UPDATE artifact_links al SET target_id = m.survivor_id FROM _fea2854_map m WHERE al.target_id = m.loser_id;

-- 4) Delete loser branch artifacts. FK cascade removes their branch_detail row
--    and the split history hanging off it (intentional per the survivor policy).
DELETE FROM artifacts WHERE id IN (SELECT loser_id FROM _fea2854_map);

-- 5) Verify the D2 key is now collision-free (the migration's own invariant).
DO $$
DECLARE remaining bigint;
BEGIN
  SELECT count(*) INTO remaining FROM (
    SELECT 1 FROM branch_detail bd
    JOIN artifacts a ON a.id = bd.artifact_id
    JOIN github_installation_repositories gir ON gir.id = bd.repository_id
    GROUP BY a.organization_id, lower(regexp_replace(btrim(gir.full_name), '\.git$', '')), bd.branch_name
    HAVING count(*) > 1
  ) d;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'FEA-2854: % duplicate group(s) remain after dedup — aborting', remaining;
  END IF;
  RAISE NOTICE 'FEA-2854: no duplicate branch-identity groups remain.';
END $$;

\if :apply
  COMMIT;
  \echo 'FEA-2854: COMMITTED. Next: prisma migrate resolve --rolled-back 20260709210000_branch_identity_d2_key_and_push_state, then redeploy api-prod.'
\else
  ROLLBACK;
  \echo 'FEA-2854: DRY RUN complete (rolled back). Re-run with -v apply=true to commit.'
\endif
