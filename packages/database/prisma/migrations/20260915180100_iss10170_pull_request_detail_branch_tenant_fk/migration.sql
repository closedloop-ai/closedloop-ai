-- ISS-10170: make the database refuse a pull_request_detail row whose
-- denormalized organization disagrees with its branch artifact's.
--
-- WHAT IT CLOSES. `pull_request_detail.organization_id` is a write-once
-- denormalization of the branch Artifact's organization, and the writers take
-- `organizationId` and `branchArtifactId` as INDEPENDENT inputs — nothing
-- relates them. While the org-wide PR aggregates reached the tenant THROUGH the
-- branch artifact join, a mismatched row was structurally impossible to
-- mis-scope, because the join decided the tenant. Once a read seeks the tenant
-- on this column instead, the denormalized value decides it, and a mismatched
-- row becomes a CROSS-TENANT READ rather than merely a wrong row. The invariant
-- is real and currently holds; this constraint is what stops it being a
-- convention.
--
-- WHY AN FK AND NOT A CHECK OR A SWEEP. A CHECK constraint cannot reference
-- another table, so the alternatives are a trigger or a periodic reconciliation
-- with a monitored event. Both DETECT; only the foreign key PREVENTS, and it
-- cannot drift because Postgres re-checks it on every insert and update of
-- either column.
--
-- ADDITIVE. `pull_request_detail_branch_artifact_id_fkey` (the single-column FK
-- on the same child column) is deliberately left in place. This constraint is a
-- strict refinement of it, both cascade from the same parent row, and dropping a
-- live referential action would be a destructive change that buys nothing.
--
-- PREFLIGHT — run this BEFORE deploying; it must return 0. A non-zero count is
-- a genuine cross-tenant row that has to be reconciled by hand (decide which of
-- the two organizations owns the PR), NOT worked around by skipping this
-- migration:
--
--   SELECT count(*)
--     FROM pull_request_detail p
--     JOIN artifacts a ON a.id = p.branch_artifact_id
--    WHERE a.organization_id <> p.organization_id;
--
-- The VALIDATE below is itself that preflight, fail-closed: it scans every
-- existing row and aborts the migration naming the constraint if one violates.
--
-- OPERATIONAL IMPACT — why NOT VALID then VALIDATE, in two statements. A plain
-- `ADD CONSTRAINT ... FOREIGN KEY` holds ACCESS EXCLUSIVE on BOTH tables for
-- the whole verification scan of pull_request_detail. Split, the `NOT VALID`
-- add takes ACCESS EXCLUSIVE only for the catalog write (sub-second, but it
-- still queues behind in-flight statements on `artifacts`), and the scan then
-- runs under SHARE UPDATE EXCLUSIVE, which does not block reads or writes.
-- Both statements land in this one migration, so the constraint is fully
-- VALID when the migration completes and matches what `schema.prisma`
-- declares — a `NOT VALID` constraint left behind would be Prisma drift.
--
-- ROLLBACK.
--   ALTER TABLE "pull_request_detail"
--     DROP CONSTRAINT "pull_request_detail_branch_artifact_tenant_fkey";
-- Reverses cleanly and instantly; no data is written or rewritten by either
-- statement below. Drop this before dropping "artifacts_org_id_key".
ALTER TABLE "pull_request_detail"
  ADD CONSTRAINT "pull_request_detail_branch_artifact_tenant_fkey"
  FOREIGN KEY ("organization_id", "branch_artifact_id")
  REFERENCES "artifacts" ("organization_id", "id")
  ON UPDATE CASCADE ON DELETE CASCADE
  NOT VALID;

ALTER TABLE "pull_request_detail"
  VALIDATE CONSTRAINT "pull_request_detail_branch_artifact_tenant_fkey";
