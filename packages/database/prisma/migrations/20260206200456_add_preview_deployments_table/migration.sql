-- CreateTable
CREATE TABLE "preview_deployments" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "url" TEXT,
    "state" TEXT,
    "environment" TEXT,
    "ref" TEXT,
    "sha" TEXT,
    "updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "preview_deployments_artifact_id_key" ON "preview_deployments"("artifact_id");

-- CreateIndex
CREATE INDEX "preview_deployments_ref_updated_at_idx" ON "preview_deployments"("ref", "updated_at");

-- AddForeignKey
ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
