-- CreateTable
CREATE TABLE "favorite_artifacts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorite_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "favorite_artifacts_artifact_id_idx" ON "favorite_artifacts"("artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "favorite_artifacts_user_id_artifact_id_key" ON "favorite_artifacts"("user_id", "artifact_id");

-- AddForeignKey
ALTER TABLE "favorite_artifacts" ADD CONSTRAINT "favorite_artifacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorite_artifacts" ADD CONSTRAINT "favorite_artifacts_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
