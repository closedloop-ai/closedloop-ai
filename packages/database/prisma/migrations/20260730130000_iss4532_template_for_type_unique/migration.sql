-- ISS-4532: restore the storage-enforced "one template per (org, templateForType)"
-- invariant (the artifacts (org, template_for_subtype) unique index dropped in
-- 20260212212450 when template_for_type moved to document_detail). Denormalize
-- template_for_type onto artifacts for a single-table partial unique index.

-- 1. Nullable column — instant add, no table rewrite.
ALTER TABLE "artifacts" ADD COLUMN "template_for_type" "ArtifactSubtype";

-- 2. Backfill existing template artifacts from their document_detail.
UPDATE "artifacts" a
SET "template_for_type" = d."template_for_type"
FROM "document_detail" d
WHERE a."id" = d."artifact_id"
  AND a."subtype" = 'TEMPLATE'
  AND d."template_for_type" IS NOT NULL;

-- 3. DESTRUCTIVE: collapse any pre-existing duplicates BEFORE the unique index.
--    Keep the MOST-RECENTLY-UPDATED template per (org, template_for_type) — the
--    copy most likely to hold the org's edited/canonical content, since a
--    duplicate created by the race may have been returned and customized after
--    (created_at would keep an unedited older copy) — and delete the rest
--    (document_detail + document versions cascade via FK). No-op if none exist.
DELETE FROM "artifacts"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
      ROW_NUMBER() OVER (
        PARTITION BY "organization_id", "template_for_type"
        ORDER BY "updated_at" DESC, "id" DESC
      ) AS rn
    FROM "artifacts"
    WHERE "subtype" = 'TEMPLATE' AND "template_for_type" IS NOT NULL
  ) ranked
  WHERE ranked.rn > 1
);

-- 4. The restored invariant.
CREATE UNIQUE INDEX "artifacts_org_template_for_type_key"
  ON "artifacts" ("organization_id", "template_for_type")
  WHERE "template_for_type" IS NOT NULL;
