/*
  Warnings:

  - You are about to drop the `repositories` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey (safe: already dropped by 20260211213240_drop_artifact_fkey_from_github_pull_requests)
ALTER TABLE "github_pull_requests" DROP CONSTRAINT IF EXISTS "github_pull_requests_artifact_id_fkey";

-- DropTable
DROP TABLE "repositories";
