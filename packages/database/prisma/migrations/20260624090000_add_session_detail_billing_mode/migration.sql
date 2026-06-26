-- Per-session billing mode resolved by the desktop (subscription vs. API-key
-- plan, from the desktop's billing_mode column). Synced opaquely and used by the
-- usage cost split to classify DESKTOP_SYNC sessions that have no source Loop.
-- AlterTable
ALTER TABLE "session_detail" ADD COLUMN     "billing_mode" TEXT;
