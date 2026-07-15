/**
 * Shared types for the operating mode abstraction layer.
 *
 * These types are framework-agnostic and can be consumed by any surface
 * (web, desktop, CLI).
 */

/**
 * Engineer routing modes -- determines how gateway requests are dispatched.
 *
 * SINGLE SOURCE OF TRUTH. This is a lightweight, workspace-only leaf
 * (`@closedloop-ai/shared-platform`) so every surface -- web, desktop, CLI -- can depend
 * on it without pulling in the heavier `@repo/api` package. `@repo/api/src/types/relay` re-exports this
 * const to preserve the historical in-repo import path; it must NOT redefine the
 * values. Literal values are a persisted, cross-process contract -- do not change
 * them without a migration.
 */
export const EngineerRoutingMode = {
  LocalElectron: "local-electron",
  CloudRelay: "cloud-relay",
} as const;

export type EngineerRoutingMode =
  (typeof EngineerRoutingMode)[keyof typeof EngineerRoutingMode];

/**
 * State returned by the gateway detection probe.
 */
export type GatewayDetectionState = {
  detected: boolean;
  loading: boolean;
  port: number | null;
  version: string | null;
  machineName: string | null;
  gatewayId: string | null;
  capabilities: Record<string, unknown> | null;
  onboardingCompleted: boolean | null;
  checkedAt: number | null;
};

/**
 * Routing selection persisted to storage.
 */
export type RoutingSelection = {
  mode: EngineerRoutingMode;
  computeTargetId: string | null;
  source: "auto" | "manual";
  updatedAt: number;
};

/**
 * Surface adapter interface for routing gateway requests.
 *
 * Each surface (web, desktop) implements this interface to handle
 * the actual request dispatch mechanics. The shared layer provides
 * detection and state primitives; adapters handle transport.
 */
export type SurfaceRoutingAdapter = {
  /** Human-readable name for the surface (e.g., "web", "desktop"). */
  readonly surfaceName: string;

  /**
   * Dispatch a gateway request through the surface-specific transport.
   * On web: fetch interceptor rewriting to localhost or relay.
   * On desktop: IPC dispatch to the local gateway process.
   */
  dispatchGatewayRequest(path: string, init?: RequestInit): Promise<Response>;

  /**
   * Whether this adapter supports the given routing mode.
   */
  supportsMode(mode: EngineerRoutingMode): boolean;
};
