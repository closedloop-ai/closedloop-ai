/**
 * @deprecated Organization compute mode — all operations now use ECS Loops.
 * The GITHUB_ACTIONS backend has been removed. Retained only for backward
 * compatibility with the settings API routes until they are cleaned up.
 */
export type ComputeMode = "GITHUB_ACTIONS" | "LOOPS";

/** @deprecated See ComputeMode. */
export type ComputeModeResponse = { computeMode: ComputeMode };

/**
 * @deprecated Per-artifact execution backend. The execution-backend route
 * and this type are no longer used — all operations route through run-loop.
 * Retained only for the settings service until it is removed.
 */
export type ExecutionBackendResponse = {
  backend: ComputeMode;
  /** Why this backend was chosen */
  reason: "loop_history" | "github_action_history" | "org_default";
};
