/**
 * Organization compute mode — determines whether artifact operations
 * (plan, execute, request-changes) use ECS Loops or GitHub Actions.
 */
export type ComputeMode = "GITHUB_ACTIONS" | "LOOPS";

export type ComputeModeResponse = { computeMode: ComputeMode };

/**
 * Per-artifact execution backend, determined by execution history.
 * The original planning backend is canonical — state cannot migrate
 * between Loops and GH Actions.
 */
export type ExecutionBackendResponse = {
  backend: ComputeMode;
  /** Why this backend was chosen */
  reason: "loop_history" | "github_action_history" | "org_default";
};
