// Phase 1: the live partial unique index in production is
// `loops_active_artifact_command_version_key` on
// `(artifact_id, command, artifact_version)` (migration
// 20260319195219_add_partial_unique_loop_artifact_command_version).
// Phase 2 (FEA-906) will replace it with `loops_active_artifact_command_key`
// on `(artifact_id, command)`. Until then the app-level gate enforces the
// broader (artifact_id, command) invariant; the DB only backstops the narrower
// (artifact_id, command, artifact_version) shape.
export const LOOP_ACTIVE_INDEX_NAME =
  "loops_active_artifact_command_version_key";

// Partial unique index backing dispatch-blocker idempotency: at most one
// deferred (BLOCKED) loop per (artifact_id, command). Closes the TOCTOU race in
// create()'s findFirst-then-insert guard where two concurrent dispatches for the
// same blocked artifact could both insert a BLOCKED row (migration
// 20260624120000_add_partial_unique_blocked_loop_artifact_command).
export const LOOP_BLOCKED_INDEX_NAME = "loops_blocked_artifact_command_key";

// 4 minutes 30 seconds — heartbeat writes are suppressed when the last
// recorded heartbeat is newer than this window (AC-001, AC-002).
export const HEARTBEAT_RATE_LIMIT_WINDOW_MS = 270_000;

// 1 week — window within which a completed or failed loop may be revived.
export const REVIVAL_GRACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Maximum number of revival attempts allowed per loop lifetime.
export const REVIVAL_MAX_PER_LOOP = 3;
