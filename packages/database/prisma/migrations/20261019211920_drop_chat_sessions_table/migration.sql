/*
  Warnings:

  - You are about to drop the `chat_sessions` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_user_id_fkey";

-- DropTable
DROP TABLE "chat_sessions";
