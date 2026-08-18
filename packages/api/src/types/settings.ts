/**
 * @deprecated Organization compute mode — all operations now use ECS Loops.
 * The GITHUB_ACTIONS backend has been removed. Retained only for backward
 * compatibility with the settings API routes until they are cleaned up.
 */
export type ComputeMode = "GITHUB_ACTIONS" | "LOOPS";

/** @deprecated See ComputeMode. */
export type ComputeModeResponse = { computeMode: ComputeMode };

/**
 * FEA-4022 (PLN-1481): org-level toggle governing whether the desktop's
 * per-session frustration signal (`SessionDetail.frustration_raw`, computed by
 * the FEA-3928 scorer) is PERSISTED to the cloud and surfaced in Insights.
 * OFF by default — the org opts in. Stored in `Organization.settings` JSON under
 * the `calculateSessionFrustration` key. When off, cloud ingest never writes the
 * raw signal (the column stays NULL) and the Insights frustration facet renders
 * a disabled/empty state.
 */
export const SESSION_FRUSTRATION_SETTING_KEY = "calculateSessionFrustration";

/** GET/PUT `/settings/frustration` response contract. */
export type SessionFrustrationSettingResponse = {
  calculateSessionFrustration: boolean;
};
