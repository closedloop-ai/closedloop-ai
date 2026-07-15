-- FEA-2854 — enumerate duplicate branch-identity groups (READ-ONLY).
--
-- Context: migration 20260709210000_branch_identity_d2_key_and_push_state
-- fails loud when the new D2 key (organization_id, repository_full_name,
-- branch_name) collapses branch_detail rows the old (repository_id, branch_name)
-- key kept distinct. This query reproduces the migration's grouping EXACTLY and
-- reports, per row, the COMPLETE dependent footprint so an operator can tell an
-- empty re-install shadow (safe auto-delete) from a row carrying real history
-- (author-guided merge).
--
-- "Complete" matters: an artifact has many ON DELETE CASCADE children beyond the
-- branch tables (favorites, tags, comment threads, ratings, evaluations, file
-- attachments, …). A blind delete would silently take those too. So dep_total is
-- computed by walking pg_constraint for EVERY FK that points at artifacts(id),
-- plus the branch grandchildren that key on branch_detail(artifact_id).
-- artifact_links is EXCLUDED (every row has a structural parent link; the merge
-- script repoints it to the survivor, it is not lost).
--
-- Safe to run against prod: SELECT-only. Run this FIRST.
--   psql "$PROD_DATABASE_URL" -f fea-2854-enumerate-branch-dups.sql

\set ON_ERROR_STOP on

-- Complete dependent count for an artifact id: every FK that references
-- artifacts(id) (any on-delete action, single-column), EXCEPT artifact_links
-- (repointed) and branch_detail's own id (the row itself), PLUS the branch
-- grandchildren keyed on branch_detail(artifact_id).
CREATE OR REPLACE FUNCTION pg_temp.fea2854_dep_count(aid uuid) RETURNS bigint AS $fn$
DECLARE r record; total bigint := 0; c bigint;
BEGIN
  FOR r IN
    SELECT con.conrelid::regclass::text AS tbl, att.attname AS col
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'artifacts'::regclass
      AND array_length(con.conkey, 1) = 1
  LOOP
    IF r.tbl = 'artifact_links' THEN CONTINUE; END IF;                       -- repointed, not counted
    IF r.tbl = 'branch_detail' AND r.col = 'artifact_id' THEN CONTINUE; END IF; -- the row itself
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.tbl, r.col) INTO c USING aid;
    total := total + c;
  END LOOP;
  -- branch grandchildren (FK to branch_detail.artifact_id, not to artifacts)
  total := total + (SELECT count(*) FROM branch_status_checks WHERE branch_artifact_id = aid);
  total := total + (SELECT count(*) FROM branch_file_changes WHERE branch_artifact_id = aid);
  total := total + (SELECT count(*) FROM github_comment_thread_projections WHERE branch_artifact_id = aid);
  RETURN total;
END $fn$ LANGUAGE plpgsql;

-- Sanity: branch rows with NULL repository_id are invisible to the D2 grouping
-- (which joins the installation repo). Pre-Phase-0 this must be 0; surfaced so
-- the operator knows the enumeration is complete.
SELECT count(*) AS branch_rows_with_null_repository_id
FROM branch_detail WHERE repository_id IS NULL;

WITH keyed AS (
  SELECT
    bd.artifact_id,
    a.organization_id                                                AS org_id,
    lower(regexp_replace(btrim(gir.full_name), '\.git$', ''))        AS repo_full_name,
    bd.branch_name,
    bd.repository_id,
    a.created_at,
    (bd.deleted_at IS NOT NULL)                                      AS soft_deleted,
    -- human-readable branch payload breakdown
    (SELECT count(*) FROM branch_status_checks x WHERE x.branch_artifact_id = bd.artifact_id) AS status_checks,
    (SELECT count(*) FROM branch_file_changes  x WHERE x.branch_artifact_id = bd.artifact_id) AS file_changes,
    (SELECT count(*) FROM pull_request_detail  x WHERE x.branch_artifact_id = bd.artifact_id) AS pr_details,
    (SELECT count(*) FROM deployment_detail    x WHERE x.branch_artifact_id = bd.artifact_id) AS deployments,
    (SELECT count(*) FROM artifact_links       x WHERE x.source_id = bd.artifact_id OR x.target_id = bd.artifact_id) AS links,
    pg_temp.fea2854_dep_count(bd.artifact_id)                        AS dep_total_complete
  FROM branch_detail bd
  JOIN artifacts a ON a.id = bd.artifact_id
  JOIN github_installation_repositories gir ON gir.id = bd.repository_id
),
dups AS (
  SELECT org_id, repo_full_name, branch_name
  FROM keyed GROUP BY org_id, repo_full_name, branch_name HAVING count(*) > 1
)
SELECT k.repo_full_name, k.branch_name, k.artifact_id, k.repository_id, k.created_at,
       k.soft_deleted, k.status_checks, k.file_changes, k.pr_details, k.deployments,
       k.links, k.dep_total_complete
FROM keyed k JOIN dups d USING (org_id, repo_full_name, branch_name)
ORDER BY k.repo_full_name, k.branch_name, k.created_at, k.artifact_id;

-- Classification: a loser is a safe auto-delete only when dep_total_complete = 0
-- (a pure empty shadow — only its branch_detail row + repointable links).
WITH keyed AS (
  SELECT bd.artifact_id,
    a.organization_id AS org_id,
    lower(regexp_replace(btrim(gir.full_name), '\.git$', '')) AS repo_full_name,
    bd.branch_name, pg_temp.fea2854_dep_count(bd.artifact_id) AS dep
  FROM branch_detail bd
  JOIN artifacts a ON a.id = bd.artifact_id
  JOIN github_installation_repositories gir ON gir.id = bd.repository_id
),
dups AS (SELECT org_id,repo_full_name,branch_name FROM keyed GROUP BY 1,2,3 HAVING count(*)>1),
grp AS (
  SELECT k.org_id,k.repo_full_name,k.branch_name,
    count(*) FILTER (WHERE k.dep>0) AS rows_with_history
  FROM keyed k JOIN dups d USING(org_id,repo_full_name,branch_name)
  GROUP BY 1,2,3
)
SELECT 'CLASSIFICATION' AS section,
  count(*) AS total_groups,
  count(*) FILTER (WHERE rows_with_history<=1) AS auto_safe_groups,
  count(*) FILTER (WHERE rows_with_history>=2) AS author_merge_groups
FROM grp;
