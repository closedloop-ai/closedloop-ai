-- CreateIndex
-- The attachment reconcile sweep (apps/api/app/documents/attachment-reconcile-service.ts)
-- partitions each list page of the file-attachments bucket into referenced vs.
-- orphaned objects with a `bucket = $1 AND key IN (...)` lookup, run once per
-- page (up to 1000 keys) over the entire table. No existing index covers
-- (bucket, key) — the table only indexes artifact_id and (artifact_id, purpose)
-- — so each lookup is a sequential scan that grows unbounded as attachments
-- accumulate. Add a composite index so the bucket-scoped key lookup is served by
-- an index scan.
CREATE INDEX "file_attachments_bucket_key_idx" ON "file_attachments"("bucket", "key");
