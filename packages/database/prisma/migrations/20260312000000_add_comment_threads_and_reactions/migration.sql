-- CreateEnum
CREATE TYPE "ThreadSource" AS ENUM ('NATIVE', 'LIVEBLOCKS');

-- CreateEnum
CREATE TYPE "ThreadStatus" AS ENUM ('OPEN', 'RESOLVED');

-- DropTable
DROP TABLE "comments";

-- CreateTable
CREATE TABLE "comment_threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "source" "ThreadSource" NOT NULL DEFAULT 'NATIVE',
    "external_id" TEXT,
    "room_id" TEXT,
    "entity_id" UUID,
    "entity_type" "EntityType",
    "status" "ThreadStatus" NOT NULL DEFAULT 'OPEN',
    "metadata" JSONB,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comment_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "thread_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" JSONB NOT NULL,
    "plain_text" TEXT,
    "external_id" TEXT,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "comment_id" UUID NOT NULL,
    "external_id" TEXT,
    "name" TEXT NOT NULL,
    "size" INTEGER,
    "mime_type" TEXT,
    "url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_reactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "comment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (comment_threads)
CREATE UNIQUE INDEX "comment_threads_organization_id_external_id_key" ON "comment_threads"("organization_id", "external_id");

CREATE INDEX "comment_threads_organization_id_entity_id_entity_type_status_idx" ON "comment_threads"("organization_id", "entity_id", "entity_type", "status");

CREATE INDEX "comment_threads_organization_id_room_id_idx" ON "comment_threads"("organization_id", "room_id");

CREATE INDEX "comment_threads_organization_id_status_updated_at_idx" ON "comment_threads"("organization_id", "status", "updated_at");

CREATE INDEX "comment_threads_created_by_id_idx" ON "comment_threads"("created_by_id");

-- CreateIndex (comments)
CREATE UNIQUE INDEX "comments_external_id_key" ON "comments"("external_id");

CREATE INDEX "comments_thread_id_created_at_idx" ON "comments"("thread_id", "created_at");

CREATE INDEX "comments_author_id_idx" ON "comments"("author_id");

CREATE INDEX "comments_deleted_at_idx" ON "comments"("deleted_at");

-- CreateIndex (comment_attachments)
CREATE UNIQUE INDEX "comment_attachments_external_id_key" ON "comment_attachments"("external_id");

CREATE INDEX "comment_attachments_comment_id_idx" ON "comment_attachments"("comment_id");

-- CreateIndex (comment_reactions)
CREATE UNIQUE INDEX "comment_reactions_comment_id_user_id_emoji_key" ON "comment_reactions"("comment_id", "user_id", "emoji");

CREATE INDEX "comment_reactions_comment_id_idx" ON "comment_reactions"("comment_id");
