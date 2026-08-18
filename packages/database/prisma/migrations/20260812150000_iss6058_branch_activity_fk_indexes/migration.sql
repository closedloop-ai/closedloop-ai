-- ISS-6058: prepare organization-scoped foreign-key targets without blocking
-- writes to the existing Branch and pull-request tables for the duration of a
-- normal index build.
--
-- NON-TRANSACTIONAL BY DESIGN. Keep this migration to bare top-level
-- CREATE INDEX CONCURRENTLY statements: PostgreSQL rejects CONCURRENTLY inside
-- a transaction block, DO block, or mixed migration wrapper. IF NOT EXISTS is
-- deliberately omitted so a retry fails closed on a same-named INVALID index.
-- Both composites include an already globally unique id, so existing rows
-- cannot violate either new uniqueness invariant.

CREATE UNIQUE INDEX CONCURRENTLY "branch_detail_org_artifact_key"
ON "branch_detail"("organization_id", "artifact_id");

CREATE UNIQUE INDEX CONCURRENTLY "pull_request_detail_org_id_key"
ON "pull_request_detail"("organization_id", "id");
