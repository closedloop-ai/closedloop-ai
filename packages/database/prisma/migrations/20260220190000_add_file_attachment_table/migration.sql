-- CreateTable
CREATE TABLE "file_attachments" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID NOT NULL,

    CONSTRAINT "file_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_attachments_artifact_id_idx" ON "file_attachments"("artifact_id");

-- AddForeignKey
ALTER TABLE "file_attachments" ADD CONSTRAINT "file_attachments_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
