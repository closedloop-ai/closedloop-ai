/*
  Warnings:

  - You are about to drop the column `data` on the `agent_session_events` table. All the data in the column will be lost.
  - You are about to drop the column `summary` on the `agent_session_events` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "agent_session_events" DROP COLUMN "data",
DROP COLUMN "summary";
