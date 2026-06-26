-- CreateTable
CREATE TABLE "public_repositories" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "github_repo_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "html_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "public_repositories_organization_id_github_repo_id_key" ON "public_repositories"("organization_id", "github_repo_id");

-- AddForeignKey
ALTER TABLE "public_repositories" ADD CONSTRAINT "public_repositories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
