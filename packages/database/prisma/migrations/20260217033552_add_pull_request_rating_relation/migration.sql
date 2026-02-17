-- DropForeignKey
ALTER TABLE "pull_request_ratings" DROP CONSTRAINT "pull_request_ratings_pull_request_id_fkey";

-- RenameIndex
ALTER INDEX "pull_request_ratings_pull_request_id_user_id_organization_id" RENAME TO "pull_request_ratings_pull_request_id_user_id_organization_i_key";
