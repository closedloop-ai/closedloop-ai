-- Re-anchor linear_subtasks from workstreamId (dropped in PLN-787) onto the
-- artifact (document) the Linear issues were exported from.
--
-- The prior column workstream_id was left as a free-floating UUID by
-- 20260602150000_delete_workstream_concept because the FK target table was
-- being dropped in the same transaction. This follow-up cleans it up.
--
-- Legacy rows have no usable document attribution — the workstreams table is
-- gone, so we can't derive document_id by traversing workstream → artifact.
-- The accept-risk decision on workstream-era data extends here: TRUNCATE
-- instead of trying to reconstruct.
--
-- This migration is hand-written. The only Prisma-inexpressible part is the
-- TRUNCATE — the DDL below matches what Prisma would generate.

BEGIN;

TRUNCATE TABLE linear_subtasks;

DROP INDEX IF EXISTS "linear_subtasks_workstream_id_is_completed_idx";
DROP INDEX IF EXISTS "linear_subtasks_workstream_id_idx";
ALTER TABLE linear_subtasks DROP COLUMN workstream_id;

ALTER TABLE linear_subtasks
  ADD COLUMN organization_id UUID NOT NULL,
  ADD COLUMN document_id UUID NOT NULL;

-- ON DELETE CASCADE so deleting an organization or a document automatically
-- cleans up its exported Linear subtasks. The schema declares matching
-- `@relation(..., onDelete: Cascade)` on LinearSubtask.organization /
-- LinearSubtask.document.
ALTER TABLE linear_subtasks
  ADD CONSTRAINT linear_subtasks_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT linear_subtasks_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES artifacts(id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX linear_subtasks_organization_id_idx
  ON linear_subtasks (organization_id);
CREATE INDEX linear_subtasks_document_id_is_completed_idx
  ON linear_subtasks (document_id, is_completed);

COMMIT;
