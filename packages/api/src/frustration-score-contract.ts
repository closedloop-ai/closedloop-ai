// Canonical FEA-3928 session-frustration scoring CONTRACT, shared so the desktop
// scorer (apps/desktop/src/shared/frustration-score.ts) that produces the value
// and the cloud/Insights side that persists and normalizes it agree on the
// version stamp and the persisted-column bounds without either duplicating the
// literal or importing across an app boundary. Consume these rather than
// redefining them locally.

/**
 * Scorer version stamped alongside every computed raw signal
 * (SessionDetail.frustration_score_version). Bump when the raw-signal formula in
 * `computeFrustrationRaw` changes so downstream re-derivation can target stale
 * rows.
 */
export const FRUSTRATION_SCORE_VERSION = 1;

/**
 * The raw signal persists to `SessionDetail.frustration_raw`, a Prisma `Int`
 * (Postgres int4), so every contribution and the final sum must stay a
 * non-negative 32-bit-signed integer. The value is deliberately UNCAPPED at 100
 * (population-relative 0–100 normalization is a downstream Insights concern),
 * but it IS capped at int4 max so a pathological transcript can never overflow
 * the column and reject the whole sync batch.
 */
export const FRUSTRATION_RAW_MAX = 2_147_483_647;
