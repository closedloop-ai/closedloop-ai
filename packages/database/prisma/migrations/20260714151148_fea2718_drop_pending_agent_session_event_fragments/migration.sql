/*
  Warnings:

  - You are about to drop the `pending_agent_session_event_fragments` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "pending_agent_session_event_fragments" DROP CONSTRAINT "pending_agent_session_event_fragments_compute_target_id_fkey";

-- DropTable
DROP TABLE "pending_agent_session_event_fragments";
