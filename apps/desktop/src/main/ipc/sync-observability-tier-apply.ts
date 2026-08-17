import type { DataSyncLevel } from "../../shared/contracts.js";
import { syncObservabilityTierToDataSyncLevel } from "../../shared/data-sync-level.js";
import { normalizeSyncObservabilityTier } from "../../shared/sync-observability-tier.js";

/**
 * FEA-4103 — the collaborators the legacy sync-consent tier setter needs to
 * collapse a tier pick onto the ONE canonical `DataSyncLevel` write path. Kept
 * electron-free (no `import "electron"`) so the handler wiring can be exercised
 * directly in the desktop `test:node` slice without booting Electron; the IPC
 * module (which does pull in `electron`) is a thin trusted-sender guard over
 * this function.
 */
export type SyncObservabilityTierApplyDeps = {
  /**
   * Persist the graduated data sync level and apply its derived
   * connectivity/sync side effects (in-memory app state + cloud socket/presence
   * updates). Implemented in app.ts (`applyDataSyncLevel`).
   */
  applyDataSyncLevel: (level: DataSyncLevel) => void;
  /**
   * FEA-3463 follow-up: notify the app when the tier is (re)chosen so a lane
   * whose sweep was suppressed while the gate was closed can re-run discovery
   * promptly instead of waiting for the next periodic sweep.
   */
  onSyncObservabilityTierChanged?: () => void;
};

/**
 * FEA-4103 — apply a legacy sync-consent tier through the canonical
 * `DataSyncLevel` path. Validates the renderer-supplied tier against the closed
 * literal set (defense-in-depth on top of the caller's trusted-sender gate),
 * maps it to its canonical level via the SSOT inverse
 * ({@link syncObservabilityTierToDataSyncLevel}), and routes it through the SAME
 * `applyDataSyncLevel` path every other consent surface uses — so all four
 * derived booleans (transcript lane, observability tier, connectivity, pause)
 * are written together and no surface can set a sub-flag out of agreement with
 * the level the "Data & Sync" UI shows. Because it routes through the level,
 * `local → off` intentionally tears down cloud connectivity (that is the whole
 * point of collapsing the last independent consent-tier setter: the tier can no
 * longer be persisted in isolation and desync the enforced egress). Returns the
 * tier the caller sent so the IPC response stays contract-compatible with older
 * renderers even though we persist by level.
 */
export function applySyncObservabilityTier(
  deps: SyncObservabilityTierApplyDeps,
  rawTier: unknown
): { tier: ReturnType<typeof normalizeSyncObservabilityTier> } {
  const tier = normalizeSyncObservabilityTier(rawTier);
  deps.applyDataSyncLevel(syncObservabilityTierToDataSyncLevel(tier));
  deps.onSyncObservabilityTierChanged?.();
  return { tier };
}
