/*
  Warnings:

  - You are about to drop the column `anthropic_api_key` on the `organizations` table. All the data in the column will be lost.
  - You are about to drop the column `anthropic_api_key` on the `users` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "organizations" DROP COLUMN "anthropic_api_key";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "anthropic_api_key";
