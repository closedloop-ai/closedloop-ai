-- Backfill `sort_order` for existing root-level DOCUMENT artifacts.
--
-- Why hand-written: this is a data migration (Prisma-inexpressible) — Prisma
-- can manage the column definition but cannot express the per-project
-- ROW_NUMBER backfill. Per packages/database/CLAUDE.md, data migrations are
-- explicitly allowed to be hand-written.
--
-- Why this exists: PLN-755 / PRD-421 introduces a "Stack rank" default sort
-- on the project page. Until this backfill runs, existing artifacts have
-- `sort_order = NULL` and the new ordering query produces a non-deterministic
-- result (Postgres NULL ordering plus tie-breakers). After this runs, every
-- root document in every project has a deterministic, project-scoped rank.
--
-- Ordering strategy:
--   * PARTITION BY project_id — rank is project-scoped
--   * ORDER BY created_at ASC — preserves the existing implicit "oldest first"
--     ordering users see today on the project page
--   * Tie-breaker by id — UUID v7 carries a time component but identical
--     created_at across two rows is possible; tie-break ensures determinism
--   * Multiplier of 1000 — leaves 999 slots between consecutive rows so a
--     single-item move can insert between two existing rows without rewriting
--     the whole project (per OQ-1 in PLN-755).
--
-- Scope: type = 'DOCUMENT' only. Stack ranking applies only to root documents
-- in the project tree per PRD-421 § Functional Requirement #1. BRANCH /
-- DEPLOYMENT / PULL_REQUEST artifacts do not participate.
--
-- Safety: this OVERWRITES any pre-existing sort_order values for DOCUMENT
-- artifacts. Safe at v1 because there is no UI that creates user-visible
-- orderings today (PRD-421 is the first such surface). Any prior values are
-- residual test data or invariants from sibling features (e.g., custom-fields
-- enum reorders), neither of which use this column.

UPDATE artifacts
SET sort_order = ranked.new_order
FROM (
  SELECT
    id,
    (ROW_NUMBER() OVER (
      PARTITION BY project_id
      ORDER BY created_at ASC, id ASC
    )) * 1000 AS new_order
  FROM artifacts
  WHERE type = 'DOCUMENT'
) AS ranked
WHERE artifacts.id = ranked.id
  AND artifacts.type = 'DOCUMENT';