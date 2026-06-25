/**
 * Shared lifecycle types for loop schedulers.
 *
 * Provides the canonical dependency interface consumed by every per-loop
 * scheduler in `LoopSchedulerContext` (heartbeat, refresh, sleep recovery).
 * Per-loop timer storage and teardown live on `LoopSchedulerContext` —
 * there is no longer any module-level registry.
 */

import type { ApiKeyProvenance } from "./api-key-store.js";
import type { DesktopPopSigner } from "./desktop-pop.js";
import type { DesktopPopUnavailableReporter } from "./desktop-pop-sign-utils.js";
import type { LoopTokenStore } from "./loop-token-store.js";

/**
 * PoP (Proof-of-Possession) signing dependencies required for heartbeat
 * revival authentication. Defined here (co-located with LoopSchedulerDeps) as
 * the SSOT so router.ts, symphony-loop.ts, and boot-recovery.ts all import
 * from one place.
 *
 * These are optional because GatewayRouterOptions declares them optional, and
 * buildManagedDesktopPopHeaders degrades gracefully when they are absent.
 */
export type LoopPopDeps = {
  getApiKey?: () => string | null;
  getApiKeyProvenance?: () => ApiKeyProvenance | null;
  signDesktopRequest?: DesktopPopSigner;
  onDesktopPopUnavailable?: DesktopPopUnavailableReporter;
};

/**
 * Shared dependency interface for per-loop scheduler entries.
 * Heartbeat, refresh, and sleep-recovery all need the same three fields, so
 * a single canonical type avoids drift.
 *
 * PoP fields (getApiKey, getApiKeyProvenance, signDesktopRequest,
 * onDesktopPopUnavailable) are optional — buildManagedDesktopPopHeaders
 * degrades gracefully for non-DESKTOP_MANAGED keys or when the signer is
 * absent. getApiKeyProvenance returns null in some contexts; call sites must
 * handle null with nullish coalescing (?? 'USER_CREATED') since
 * buildManagedDesktopPopHeaders requires a non-nullable ApiKeyProvenance.
 *
 * NOTE: isProcessRunning, getTokenMeta, and telemetry are HeartbeatDeps-only
 * fields — they belong in the HeartbeatDeps intersection block, NOT here.
 */
export interface LoopSchedulerDeps extends LoopPopDeps {
  apiBaseUrl: string;
  getToken: () => string | null;
  loopTokenStore: LoopTokenStore;
}

/**
 * Reads an env var as a non-negative integer millisecond value.
 * Returns `defaultMs` when the var is absent or not a valid non-negative integer.
 */
export function parseEnvMs(envVar: string, defaultMs: number): number {
  const override = process.env[envVar];
  if (override !== undefined) {
    const parsed = Number.parseInt(override, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return defaultMs;
}
