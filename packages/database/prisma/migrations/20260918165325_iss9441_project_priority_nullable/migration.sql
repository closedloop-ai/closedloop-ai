-- ISS-9441 / ISS-9833 (ruled 2026-09-14): a project's priority is the same field
-- as an artifact's, so `projects.priority` takes the artifact contract — nullable,
-- no default, an explicit null clears.
--
-- THERE IS DELIBERATELY NO UPDATE. Rows already storing 'MEDIUM' keep it by that
-- ruling, and they could not be corrected even if the ruling said otherwise: the
-- 2026-02-24 migration that rewrote 'NOT_SET' to 'MEDIUM' left no marker, so a
-- value a human chose is indistinguishable from one that migration wrote.
--
-- LOCK PROFILE: both clauses are catalog-only. DROP NOT NULL clears
-- pg_attribute.attnotnull and DROP DEFAULT clears the pg_attrdef row; neither
-- rewrites the heap or scans it, so the ACCESS EXCLUSIVE lock this statement takes
-- is held only for the catalog write. Safe on a live table of any size.
--
-- ROLLBACK (forward-only, consistent with the ruling that unset means MEDIUM).
-- Run both statements in ONE transaction so a concurrent clear cannot land between
-- the backfill and the constraint and fail SET NOT NULL:
--   UPDATE "projects" SET "priority" = 'MEDIUM' WHERE "priority" IS NULL;
--   ALTER TABLE "projects" ALTER COLUMN "priority" SET DEFAULT 'MEDIUM',
--                          ALTER COLUMN "priority" SET NOT NULL;
-- It loses only which projects a user explicitly cleared. Re-project the touched
-- rows through the search backfill's --only selector (ISS-9699).

-- AlterTable
ALTER TABLE "projects" ALTER COLUMN "priority" DROP NOT NULL,
ALTER COLUMN "priority" DROP DEFAULT;
