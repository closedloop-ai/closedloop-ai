-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_projects" (
    "id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_workstreams" (
    "id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "workstream_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_workstreams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_artifacts" (
    "id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_loops" (
    "id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "loop_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_loops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tags_organization_id_idx" ON "tags"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_organization_id_name_key" ON "tags"("organization_id", "name");

-- CreateIndex
CREATE INDEX "tag_projects_project_id_idx" ON "tag_projects"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "tag_projects_tag_id_project_id_key" ON "tag_projects"("tag_id", "project_id");

-- CreateIndex
CREATE INDEX "tag_workstreams_workstream_id_idx" ON "tag_workstreams"("workstream_id");

-- CreateIndex
CREATE UNIQUE INDEX "tag_workstreams_tag_id_workstream_id_key" ON "tag_workstreams"("tag_id", "workstream_id");

-- CreateIndex
CREATE INDEX "tag_artifacts_artifact_id_idx" ON "tag_artifacts"("artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "tag_artifacts_tag_id_artifact_id_key" ON "tag_artifacts"("tag_id", "artifact_id");

-- CreateIndex
CREATE INDEX "tag_loops_loop_id_idx" ON "tag_loops"("loop_id");

-- CreateIndex
CREATE UNIQUE INDEX "tag_loops_tag_id_loop_id_key" ON "tag_loops"("tag_id", "loop_id");

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_projects" ADD CONSTRAINT "tag_projects_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_projects" ADD CONSTRAINT "tag_projects_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_workstreams" ADD CONSTRAINT "tag_workstreams_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_workstreams" ADD CONSTRAINT "tag_workstreams_workstream_id_fkey" FOREIGN KEY ("workstream_id") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_artifacts" ADD CONSTRAINT "tag_artifacts_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_artifacts" ADD CONSTRAINT "tag_artifacts_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_loops" ADD CONSTRAINT "tag_loops_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_loops" ADD CONSTRAINT "tag_loops_loop_id_fkey" FOREIGN KEY ("loop_id") REFERENCES "loops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
