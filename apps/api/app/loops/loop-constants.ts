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
