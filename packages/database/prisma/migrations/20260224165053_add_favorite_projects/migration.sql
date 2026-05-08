-- CreateTable
CREATE TABLE "favorite_projects" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorite_projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "favorite_projects_user_id_idx" ON "favorite_projects"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "favorite_projects_user_id_project_id_key" ON "favorite_projects"("user_id", "project_id");
