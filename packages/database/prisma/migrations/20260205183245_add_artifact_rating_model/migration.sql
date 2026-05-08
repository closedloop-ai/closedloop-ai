-- CreateTable
CREATE TABLE "artifact_ratings" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" VARCHAR(500),
    "artifact_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artifact_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artifact_ratings_artifact_id_organization_id_idx" ON "artifact_ratings"("artifact_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_ratings_artifact_id_user_id_organization_id_key" ON "artifact_ratings"("artifact_id", "user_id", "organization_id");
