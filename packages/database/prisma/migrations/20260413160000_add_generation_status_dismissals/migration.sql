-- CreateTable
CREATE TABLE "artifact_generation_status_dismissals" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "dismissed_by_id" UUID NOT NULL,
    "run_key" TEXT NOT NULL,
    "dismissed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artifact_generation_status_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "artifact_generation_status_dismissals_artifact_id_key"
ON "artifact_generation_status_dismissals"("artifact_id");

-- CreateIndex
CREATE INDEX "artifact_generation_status_dismissals_dismissed_by_id_idx"
ON "artifact_generation_status_dismissals"("dismissed_by_id");

-- AddForeignKey
ALTER TABLE "artifact_generation_status_dismissals"
ADD CONSTRAINT "artifact_generation_status_dismissals_artifact_id_fkey"
FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_generation_status_dismissals"
ADD CONSTRAINT "artifact_generation_status_dismissals_dismissed_by_id_fkey"
FOREIGN KEY ("dismissed_by_id") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
