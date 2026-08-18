-- ISS-4815: durable record of an AUTHORITATIVE cloud `uploaded` acknowledgement
-- for a transcript the local lane could not upload itself (a missing source the
-- cloud already holds a verified archive for). The queue `status` stays `idle`
-- — there is genuinely no work left — and this column records WHY, so the
-- stranded-missing-blob recovery can leave the row settled instead of re-arming
-- it (and replaying the whole missing-source failure ladder) on every launch.
--
-- Nullable with no backfill on purpose: every pre-migration row keeps NULL, so
-- it stays eligible for the recovery exactly as it is today. Only a fresh
-- acknowledgement writes a value.
ALTER TABLE "transcript_sync_state" ADD COLUMN "cloud_uploaded_at" TEXT;

-- WHICH compute target's cloud gave that acknowledgement. An `uploaded` ack is
-- only ever a statement about the archive held by the target that answered, so
-- the recovery scopes its exclusion to this id: after the user switches
-- accounts/compute targets the row becomes eligible again, because the NEW
-- target's cloud does not hold the transcript and the local cursor is still 0.
-- Without it a single ack would settle the row forever and the transcript would
-- never reach the new target. Same per-target discipline ISS-4647 applied to the
-- byte cursor, kept in its own column because this is the ack's ORIGIN, not the
-- cursor's domain — so it stores the RAW compute target id (no redacted-archive
-- suffix). NULL is unattributable and stays eligible for recovery.
ALTER TABLE "transcript_sync_state" ADD COLUMN "cloud_uploaded_compute_target_id" TEXT;
