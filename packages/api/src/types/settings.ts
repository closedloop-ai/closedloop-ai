/**
 * @deprecated Organization compute mode — all operations now use ECS Loops.
 * The GITHUB_ACTIONS backend has been removed. Retained only for backward
 * compatibility with the settings API routes until they are cleaned up.
 */
export type ComputeMode = "GITHUB_ACTIONS" | "LOOPS";

/** @deprecated See ComputeMode. */
export type ComputeModeResponse = { computeMode: ComputeMode };
