-- FEA-2271 (PRD-488): subagent purpose attribution provenance marker.
-- Additive nullable column recording the parser-stable local subagent id when a
-- segment's spend was re-filed to a delegated subagent's own purpose phase; null
-- for main-agent segments. No phase-column change (taxonomy stays data); the
-- ACTIVITY_CLASSIFIER_VERSION bump re-derives the value over all history via the
-- FEA-2267 backfill. Existing installs apply only this migration.
ALTER TABLE "session_activity_segments" ADD COLUMN "subagent_id" TEXT;
