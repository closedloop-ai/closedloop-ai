-- AlterTable
ALTER TABLE "pull_request_detail" ADD COLUMN     "author_actor_type" VARCHAR(32),
ADD COLUMN     "author_provider_user_id" TEXT;
