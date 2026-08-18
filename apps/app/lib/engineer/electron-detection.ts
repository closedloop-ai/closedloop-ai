"use client";

/**
 * Desktop gateway detection store (web entry point).
 *
 * The implementation is the single source of truth in
 * `@repo/shared-platform/detection-store`; this module only re-exports it under
 * the historical `Electron*`-prefixed names so existing app consumers keep their
 * import path (`@/lib/engineer/electron-detection`). Do NOT reimplement the store
 * here -- that would fork the module-level detection singleton across surfaces.
 */
export {
  ensureGatewayDetection as ensureElectronDetection,
  getAbsentSweepCount as getElectronAbsentSweepCount,
  getGatewayDetectionSnapshot as getElectronDetectionSnapshot,
  getNextProbeDelayMs as getElectronNextProbeDelayMs,
  invalidateGatewayDetectionCache as invalidateElectronDetectionCache,
  isGatewayDetectionExhausted as isElectronDetectionExhausted,
  isRecoveringGatewayDetection as isRecoveringElectronDetection,
  rearmGatewayDetection as rearmElectronDetection,
  resetGatewayDetectionForTests as resetElectronDetectionForTests,
  subscribeGatewayDetection as subscribeElectronDetection,
  useGatewayDetection as useElectronDetection,
} from "@repo/shared-platform/detection-store";
export type { GatewayDetectionState as ElectronDetectionState } from "@repo/shared-platform/types";
