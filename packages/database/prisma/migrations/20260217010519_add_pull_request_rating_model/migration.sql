-- CreateTable
CREATE TABLE "pull_request_ratings" (
    "id" UUID NOT NULL,
    "pull_request_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_request_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pull_request_ratings_pull_request_id_organization_id_idx" ON "pull_request_ratings"("pull_request_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "pull_request_ratings_pull_request_id_user_id_organization_id" ON "pull_request_ratings"("pull_request_id", "user_id", "organization_id");

-- AddForeignKey
ALTER TABLE "pull_request_ratings" ADD CONSTRAINT "pull_request_ratings_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "github_pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
