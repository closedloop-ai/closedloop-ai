-- FEA-4022 (PLN-1481, follow-on to FEA-3928): desktop-local persistence for the
-- raw session-frustration signal. The desktop scorer
-- (src/shared/frustration-score.ts, `computeFrustrationRaw`) folds a session's
-- language heuristic, nearby-error spikes, and derived trace-signal counts into a
-- single UNBOUNDED additive integer at sync-source assembly; that raw value and
-- the scorer version stamp are cached on the session row here so a re-sync does
-- not have to recompute them.
--
-- NULLABLE ON PURPOSE, NO DEFAULT: NULL means "not computed" for a legacy/unscored
-- row. The value is deliberately NOT clamped to 100 — the population-relative
-- 0..max→0..100 normalization is a downstream cloud-Insights concern. SQLite
-- INTEGER is 64-bit, so it comfortably holds the int4-safe raw value the scorer
-- saturates at (FRUSTRATION_RAW_MAX). Both columns are always written together.
ALTER TABLE "sessions" ADD COLUMN "frustration_raw" INTEGER;
ALTER TABLE "sessions" ADD COLUMN "frustration_score_version" INTEGER;
