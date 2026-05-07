-- CreateTable
CREATE TABLE "team_repositories" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "installation_repository_id" UUID NOT NULL,
    "is_default_selected" BOOLEAN NOT NULL DEFAULT false,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_repositories_installation_repository_id_idx" ON "team_repositories"("installation_repository_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_repositories_team_id_installation_repository_id_key" ON "team_repositories"("team_id", "installation_repository_id");

-- AddForeignKey
ALTER TABLE "team_repositories" ADD CONSTRAINT "team_repositories_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_repositories" ADD CONSTRAINT "team_repositories_installation_repository_id_fkey" FOREIGN KEY ("installation_repository_id") REFERENCES "github_installation_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
