/**
 * @file session-limits-channel.ts
 * @description Shared IPC channel + payload types for the subscription
 * session-limit surface (PRD-538), imported by the main handler, the preload
 * bridge, and the renderer type contract so all three agree on one shape.
 */

// Type-only (runtime-erased): the renderer package `@repo/app` owns the
// canonical source union; this main-process module re-declares the literals to
// stay free of the `@repo/app` runtime graph, and asserts equality below so the
// two declarations cannot drift when a producer is added.
import type { SessionLimitSource as RendererSessionLimitSource } from "@repo/app/session-limits/types";

export const SessionLimitsIpcChannel = {
  Get: "desktop:get-session-limits",
  GetStatuslineCaptureEnabled: "desktop:get-statusline-capture-enabled",
  SetStatuslineCaptureEnabled: "desktop:set-statusline-capture-enabled",
} as const;
export type SessionLimitsIpcChannel =
  (typeof SessionLimitsIpcChannel)[keyof typeof SessionLimitsIpcChannel];

/**
 * Result of toggling the statusline-capture opt-in (FEA-3492). Shared so the
 * main handler, the preload bridge, and the renderer `DesktopApi` contract all
 * agree on one shape rather than duplicating the literal.
 */
export type StatuslineCaptureResult = {
  ok: boolean;
  enabled: boolean;
  error?: string;
};

/** One rate-limit window: server-computed utilization (0–100) + reset time. */
export type RateLimitSnapshot = {
  utilization: number;
  resetsAt: string | null;
};

/**
 * Which producer captured the snapshot the renderer is showing. SSOT for the
 * source union — the snapshot store's `SessionLimitSnapshotSource` values are
 * these literals, and the renderer's `SessionLimits.source` mirrors this so the
 * detail drawer can label the data's provenance.
 *  - `usage_api` — AUTHORITATIVE: the owned `GET /api/oauth/usage` endpoint,
 *    the same one Claude Code's `/usage` reads (PRD-538 R5). Server-computed
 *    utilization for every window, so it outranks both local producers;
 *  - `statusline` — RICH interactive statusline `rate_limits` (continuous %);
 *  - `rate_limit_event` — COARSE non-interactive `SDKRateLimitInfo`.
 */
export type SessionLimitSource =
  | "usage_api"
  | "statusline"
  | "rate_limit_event";

/**
 * Compile-time drift guard: this main-process union must stay exactly equal to
 * the renderer's canonical `SessionLimitSource` (SSOT in
 * `@repo/app/session-limits/types`). If a producer is added on one side only,
 * `SessionLimitSourceTwin` fails to resolve to `true` and typecheck breaks —
 * `formatSourceLabel` can no longer silently omit the new value. Runtime-erased
 * (the import is `import type`), so it adds nothing to the main-process bundle.
 */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type SessionLimitSourceTwin = Equals<
  SessionLimitSource,
  RendererSessionLimitSource
>;
const _sessionLimitSourceTwin: SessionLimitSourceTwin = true;

/** The subscription session-limit snapshot returned to the renderer. */
export type SessionLimitsSnapshot = {
  fiveHour: RateLimitSnapshot | null;
  sevenDay: RateLimitSnapshot | null;
  sevenDayOpus: RateLimitSnapshot | null;
  sevenDaySonnet: RateLimitSnapshot | null;
  extraUsage: {
    isEnabled: boolean;
    monthlyLimitUsd: number | null;
    usedCreditsUsd: number | null;
    utilization: number | null;
  } | null;
  fetchedAt: string | null;
  /**
   * Which producer captured this snapshot, stamped by the reconciler. Absent on
   * the (currently null) CLI-fetch path and on pre-reconcile mapper output;
   * present once the store resolves a stored sample. Drives the detail drawer's
   * provenance label.
   */
  source?: SessionLimitSource | null;
};

/**
 * True when a snapshot carries at least one renderable window. Mirrors the
 * renderer's `hasAnySessionLimit` (packages/app/session-limits/types) so the
 * main process and the renderer agree on what counts as "empty": a snapshot with
 * every window null (and no active extra-usage utilization) draws nothing and is
 * hidden by the nav. Producers use this to avoid recording an empty snapshot that
 * would otherwise win reconciliation and suppress a non-empty sample from another
 * source (FEA-3523).
 */
export function hasRenderableSessionLimit(
  snapshot: SessionLimitsSnapshot
): boolean {
  return Boolean(
    snapshot.fiveHour ||
      snapshot.sevenDay ||
      snapshot.sevenDayOpus ||
      snapshot.sevenDaySonnet ||
      (snapshot.extraUsage?.isEnabled &&
        snapshot.extraUsage.utilization !== null)
  );
}
