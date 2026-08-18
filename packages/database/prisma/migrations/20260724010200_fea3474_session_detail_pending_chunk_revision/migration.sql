-- FEA-3474 (PRD-536 D3): stage the identity of an in-progress chunked-apply
-- sequence so the last chunk commits the revision only for the same sequence its
-- first chunk started (revision) AND only when every leading chunk arrived
-- (total + contiguous received-count). All nullable, no default; existing rows
-- and every unchunked session are NULL (no sequence mid-apply).
-- AlterTable
ALTER TABLE "session_detail" ADD COLUMN     "pending_chunk_revision" INTEGER,
ADD COLUMN     "pending_chunk_total" INTEGER,
ADD COLUMN     "pending_chunk_received" INTEGER;
