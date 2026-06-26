-- CreateEnum
CREATE TYPE "ExternalCommentProvider" AS ENUM ('GITHUB');

-- CreateTable
CREATE TABLE "external_comment_authors" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" "ExternalCommentProvider" NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "provider_node_id" TEXT,
    "provider_login" TEXT NOT NULL,
    "normalized_provider_login" TEXT NOT NULL,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "profile_url" TEXT,
    "user_id" UUID NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_comment_authors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_user_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "github_user_id" TEXT NOT NULL,
    "github_node_id" TEXT,
    "login" TEXT NOT NULL,
    "normalized_login" TEXT NOT NULL,
    "avatar_url" TEXT,
    "profile_url" TEXT,
    "access_token_encrypted" TEXT NOT NULL,
    "refresh_token_encrypted" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_user_connections_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "github_pr_review_comments" ADD COLUMN "external_author_id" UUID;

-- AlterTable
ALTER TABLE "github_comment_projections" ADD COLUMN "external_author_id" UUID;

-- CreateIndex
CREATE INDEX "external_comment_authors_organization_id_provider_normalize_idx" ON "external_comment_authors"("organization_id", "provider", "normalized_provider_login");

-- CreateIndex
CREATE INDEX "external_comment_authors_user_id_idx" ON "external_comment_authors"("user_id");

-- CreateIndex
CREATE INDEX "github_pr_review_comments_external_author_id_idx" ON "github_pr_review_comments"("external_author_id");

-- CreateIndex
CREATE INDEX "github_comment_projections_external_author_id_idx" ON "github_comment_projections"("external_author_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_comment_authors_organization_id_provider_provider__key" ON "external_comment_authors"("organization_id", "provider", "provider_user_id");

-- CreateIndex
CREATE INDEX "github_user_connections_organization_id_normalized_login_idx" ON "github_user_connections"("organization_id", "normalized_login");

-- CreateIndex
CREATE INDEX "github_user_connections_revoked_at_idx" ON "github_user_connections"("revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "github_user_connections_organization_id_user_id_key" ON "github_user_connections"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_user_connections_organization_id_github_user_id_key" ON "github_user_connections"("organization_id", "github_user_id");

-- AddForeignKey
ALTER TABLE "external_comment_authors" ADD CONSTRAINT "external_comment_authors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_comment_authors" ADD CONSTRAINT "external_comment_authors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_pr_review_comments" ADD CONSTRAINT "github_pr_review_comments_external_author_id_fkey" FOREIGN KEY ("external_author_id") REFERENCES "external_comment_authors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_comment_projections" ADD CONSTRAINT "github_comment_projections_external_author_id_fkey" FOREIGN KEY ("external_author_id") REFERENCES "external_comment_authors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_user_connections" ADD CONSTRAINT "github_user_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_user_connections" ADD CONSTRAINT "github_user_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
