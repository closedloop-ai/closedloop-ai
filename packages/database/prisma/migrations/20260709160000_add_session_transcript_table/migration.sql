-- CreateTable
CREATE TABLE "session_transcript" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "compute_target_id" UUID NOT NULL,
    "external_session_id" TEXT NOT NULL,
    "session_detail_id" UUID,
    "source_harness" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "object_storage_key" TEXT NOT NULL,
    "upload_status" TEXT NOT NULL DEFAULT 'pending',
    "raw_sha256" TEXT,
    "crc64nvme" TEXT,
    "raw_byte_size" BIGINT,
    "stored_etag" TEXT,
    "synced_byte_offset" BIGINT NOT NULL DEFAULT 0,
    "source_mtime" TIMESTAMP(3),
    "source_path_hash" TEXT,
    "pending_upload_id" TEXT,
    "pending_upload_started_at" TIMESTAMP(3),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_transcript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_transcript_organization_id_idx" ON "session_transcript"("organization_id");

-- CreateIndex
CREATE INDEX "session_transcript_session_detail_id_idx" ON "session_transcript"("session_detail_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_transcript_compute_target_id_external_session_id_fi_key" ON "session_transcript"("compute_target_id", "external_session_id", "file_key");

-- AddForeignKey
ALTER TABLE "session_transcript" ADD CONSTRAINT "session_transcript_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_transcript" ADD CONSTRAINT "session_transcript_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_transcript" ADD CONSTRAINT "session_transcript_session_detail_id_fkey" FOREIGN KEY ("session_detail_id") REFERENCES "session_detail"("artifact_id") ON DELETE SET NULL ON UPDATE CASCADE;
