-- CreateTable
-- Prisma emits nullable SQL for required scalar lists; enforce the reader's
-- array contract here because PSL cannot express this NOT NULL constraint.
CREATE TABLE "artifact_link_tree_pages" (
    "snapshot_id" UUID NOT NULL,
    "offset" INTEGER NOT NULL,
    "organization_id" UUID NOT NULL,
    "query_key" TEXT NOT NULL,
    "link_ids" UUID[] NOT NULL,
    "has_more" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artifact_link_tree_pages_pkey" PRIMARY KEY ("snapshot_id","offset")
);

-- CreateIndex
-- index-lock-ok(artifact_link_tree_pages): table is created empty in this migration; these scope and retention indexes lock zero rows, and CONCURRENTLY cannot share the table-creation transaction
CREATE INDEX IF NOT EXISTS "artifact_link_tree_pages_organization_id_query_key_offset_c_idx" ON "artifact_link_tree_pages"("organization_id", "query_key", "offset", "created_at" DESC);

-- CreateIndex
-- index-lock-ok(artifact_link_tree_pages): table is created empty in this migration; these scope and retention indexes lock zero rows, and CONCURRENTLY cannot share the table-creation transaction
CREATE INDEX IF NOT EXISTS "artifact_link_tree_pages_expires_at_idx" ON "artifact_link_tree_pages"("expires_at");

-- AddForeignKey
ALTER TABLE "artifact_link_tree_pages" ADD CONSTRAINT "artifact_link_tree_pages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
