-- Add the new column nullable so existing rows can be backfilled, then
-- backfill from the legacy target_repo / target_branch fields, then enforce
-- NOT NULL. Migration B (a follow-on) drops the legacy columns after
-- consumer code stops reading them. See PLN-602.

-- Step 1: add nullable column.
ALTER TABLE "document_detail" ADD COLUMN "repository_snapshot" JSONB;

-- Step 2: backfill. Rows with a target_repo get a single-entry snapshot
-- marked as `legacy`; rows with no target_repo get an empty snapshot
-- marked as `none`. branch may be NULL on the legacy entry.
UPDATE "document_detail"
SET "repository_snapshot" = jsonb_build_object(
  'repositories', jsonb_build_array(
    jsonb_build_object(
      'fullName', "target_repo",
      'role', 'primary',
      'position', 0,
      'branch', "target_branch"
    )
  ),
  'source', 'legacy',
  'createdAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
WHERE "target_repo" IS NOT NULL
  AND "repository_snapshot" IS NULL;

UPDATE "document_detail"
SET "repository_snapshot" = jsonb_build_object(
  'repositories', '[]'::jsonb,
  'source', 'none',
  'createdAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
WHERE "repository_snapshot" IS NULL;

-- Step 3: enforce NOT NULL now that every row has a snapshot.
ALTER TABLE "document_detail" ALTER COLUMN "repository_snapshot" SET NOT NULL;
