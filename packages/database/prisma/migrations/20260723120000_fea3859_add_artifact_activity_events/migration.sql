-- CreateTable
CREATE TABLE "artifact_activity_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artifact_activity_events_organization_id_artifact_id_create_idx" ON "artifact_activity_events"("organization_id", "artifact_id", "created_at");

-- AddForeignKey
ALTER TABLE "artifact_activity_events" ADD CONSTRAINT "artifact_activity_events_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
