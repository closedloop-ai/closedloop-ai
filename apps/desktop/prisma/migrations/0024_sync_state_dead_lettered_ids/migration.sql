-- Record intentionally-abandoned (dead-lettered) session ids on the durable
-- sync cursor so the watermark can advance past them. Without this, a non-empty
-- dead-letter set blocked cursor persistence and every restart re-walked all
-- local sessions. Additive + nullable → cursors written before this column
-- load as `[]` (no dead-letters set aside).

-- AlterTable
ALTER TABLE "sync_state" ADD COLUMN "dead_lettered_ids" JSONB;
