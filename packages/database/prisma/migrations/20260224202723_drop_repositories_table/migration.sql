/*
  Warnings:

  - You are about to drop the `repositories` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "github_pull_requests" DROP CONSTRAINT "github_pull_requests_artifact_id_fkey";

-- DropTable
DROP TABLE "repositories";
