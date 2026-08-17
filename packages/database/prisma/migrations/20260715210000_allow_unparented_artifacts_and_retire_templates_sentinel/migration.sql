-- =============================================================================
-- FEA-1749 / PLN-1354 Phases 1-2: permit any artifact type to be unparented,
-- and retire the hidden per-org "Templates" sentinel Project.
--
-- HAND-WRITTEN IN FULL, and why (packages/database/CLAUDE.md asks for the
-- justification): all but one statement here is something Prisma cannot
-- generate, and the one that it could generate cannot be safely separated from
-- the rest.
--   - Step 1 (DROP CONSTRAINT) — Prisma does not model CHECK constraints, so
--     `migrate diff` will never emit this. 20260610220145 added it the same way.
--   - Steps 2-3 (UPDATE / DELETE) — data migration; Prisma generates no DML.
--   - Step 4b (DROP INDEX ..._org_one_templates_sentinel) — a PARTIAL unique
--     index, likewise inexpressible in schema.prisma.
--   - Steps 4a + 5 (DROP INDEX ..._idx, DROP COLUMN) — Prisma WOULD generate
--     these from this commit's schema.prisma edits. They stay here because the
--     column drop MUST be sequenced after the guarded delete in step 3, in one
--     transaction. Splitting them into a generated migration would either run
--     the drop before the guard or lose the ordering guarantee that keeps the
--     D1xD3 hazard survivable.
--
-- ⚠️ STEP ORDER IS LOAD-BEARING — see the D1xD3 hazard in PLN-1354.
-- `Artifact.project` is `onDelete: Cascade` (D1) and stays that way. Deleting a
-- sentinel Project while templates still point at it would CASCADE-DELETE every
-- template in that org. Step 3 must therefore run AFTER step 2 has nulled them
-- out. The assertions below make that failure loud instead of silent: this
-- migration aborts rather than destroy templates.
-- =============================================================================

-- 1. Drop the invariant CHECK (D6). The absence of a mechanism to create a
--    project-less document is sufficient; the entry-point validators (and not
--    storage) decide what is creatable. No replacement constraint.
--    MUST BE FIRST: step 2 writes a NULL this constraint forbids.
ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "artifacts_non_session_project_required";

-- 2. Unparent every TEMPLATE (D3). Templates are org-level and are fetched via
--    `document.templateForType`, never by project, so the sentinel was
--    write-only scaffolding. MUST PRECEDE step 3.
UPDATE "artifacts"
  SET "project_id" = NULL
  WHERE "subtype" = 'TEMPLATE'::"ArtifactSubtype"
    AND "project_id" IS NOT NULL;

-- 3. Delete the sentinel Projects, guarded on both sides.
DO $$
DECLARE
  orphaned_artifacts INTEGER;
  templates_before INTEGER;
  templates_after INTEGER;
BEGIN
  SELECT COUNT(*) INTO templates_before
    FROM "artifacts"
    WHERE "subtype" = 'TEMPLATE'::"ArtifactSubtype";

  -- PRE-CONDITION: nothing may still point at a sentinel. This is the cascade
  -- guard — it covers TEMPLATEs that step 2 missed AND any other artifact that
  -- was parented to a sentinel by some path we have not anticipated. If this
  -- fires, DO NOT relax it: the DELETE below would destroy those rows.
  SELECT COUNT(*) INTO orphaned_artifacts
    FROM "artifacts" a
    JOIN "projects" p ON p."id" = a."project_id"
    WHERE p."is_templates_sentinel" = true;

  IF orphaned_artifacts > 0 THEN
    RAISE EXCEPTION
      'Refusing to delete templates sentinel projects: % artifact(s) still reference one; deleting would cascade-delete them (FEA-1749 D1xD3 hazard)',
      orphaned_artifacts;
  END IF;

  DELETE FROM "projects" WHERE "is_templates_sentinel" = true;

  -- POST-CONDITION: the delete must not have taken any template with it.
  SELECT COUNT(*) INTO templates_after
    FROM "artifacts"
    WHERE "subtype" = 'TEMPLATE'::"ArtifactSubtype";

  IF templates_after <> templates_before THEN
    RAISE EXCEPTION
      'Templates sentinel deletion destroyed templates: % before, % after (FEA-1749 D1xD3 hazard)',
      templates_before, templates_after;
  END IF;
END $$;

-- 4. Drop both indexes on the flag. Postgres would cascade these off the column
--    drop in step 5 anyway; they are explicit because the second one is
--    invisible to Prisma:
--      - projects_organization_id_is_templates_sentinel_idx — modelled in
--        schema.prisma as @@index([organizationId, isTemplatesSentinel]).
--      - projects_org_one_templates_sentinel — a PARTIAL unique index
--        ("at most one sentinel per org"). Prisma cannot express partial
--        indexes, so, like the CHECK in step 1, it exists only in raw SQL and
--        `migrate diff` will never generate its removal.
DROP INDEX IF EXISTS "projects_organization_id_is_templates_sentinel_idx";
DROP INDEX IF EXISTS "projects_org_one_templates_sentinel";

-- 5. Drop the sentinel flag. Nothing reads it once the exclusion filters that
--    existed only to hide the sentinel are gone (Phase 2, same commit).
ALTER TABLE "projects" DROP COLUMN IF EXISTS "is_templates_sentinel";
