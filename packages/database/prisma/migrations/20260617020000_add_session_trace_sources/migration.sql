-- Additive Session Trace source records. Raw prompt text and unrestricted raw
-- event payloads remain outside these bounded JSON source columns.
ALTER TABLE "session_detail"
  ADD COLUMN "trace_phase_sources" JSONB,
  ADD COLUMN "throttle_sources" JSONB,
  ADD COLUMN "correction_sources" JSONB;
