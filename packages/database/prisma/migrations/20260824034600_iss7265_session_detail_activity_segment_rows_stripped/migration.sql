-- ISS-7265: durable per-session record of the desktop's tiling STRIP — the
-- bounded old-server fallback that ships a session without its activity-segment
-- tiling so the rest of it can sync.
--
-- Nullable and additive, with three meanings rather than two. NULL is "no payload
-- has ever reported on this session's tiling" (a pre-ISS-7265 row, or a desktop
-- build too old to send `activitySegmentRowsStripped`); FALSE is "a payload
-- carried the tiling"; TRUE is "a payload deliberately shipped without it".
-- Defaulting to FALSE would assert the negative for every unreported row, which
-- is the same false-completeness the wire flag was added to remove.

-- AlterTable
ALTER TABLE "session_detail" ADD COLUMN     "activity_segment_rows_stripped" BOOLEAN;
