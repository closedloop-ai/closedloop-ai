/**
 * @file fake-desktop-sync-lane-deps.ts
 * @description A fully-valid, inert {@link DesktopSyncLaneDeps} builder for
 * tests that exercise one small pure function of the composition (e.g.
 * `laneDeliveryConsented`, `identityBoundTranscriptComputeTargetId`) without
 * driving the whole `createDesktopSyncLanes` factory. Every field defaults to
 * an inert stub; a test overrides only the field(s) the function under test
 * actually reads.
 */
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { DesktopSyncLaneDeps } from "../src/main/agent-sync/desktop-sync-lane-composition.js";
import { inertDesktopOtelRuntime } from "./inert-desktop-otel-runtime.js";

export function fakeDesktopSyncLaneDeps(
  overrides: Partial<DesktopSyncLaneDeps> = {}
): DesktopSyncLaneDeps {
  return {
    desktopSessionManager: {
      getAccessToken: () => Promise.resolve(null),
      getAccountAdmission: () => null,
      getIdentity: () => null,
      invalidateAccessToken: () => undefined,
    },
    getApiKey: () => null,
    getApiOrigin: () => "https://api.example.test",
    getTranscriptComputeTargetId: () => null,
    getSyncComputeTargetId: () => null,
    getComputeTargetRefusal: () => null,
    isSessionMetadataSyncTierAllowed: () => true,
    hasSyncObservabilityTierBeenSet: () => true,
    hasRecordedSyncConsent: () => true,
    getDataSyncLevel: () => "full" as DataSyncLevel,
    isHttpAgentSessionSyncReady: () => false,
    isInitialSessionProjectionReady: () => true,
    isSyncCompressionSupported: () => false,
    isSyncActivityChunkingSupported: () => false,
    getSyncSource: () => null,
    waitForBackgroundSlot: () => Promise.resolve(),
    appOtelRuntime: inertDesktopOtelRuntime(),
    isTranscriptSyncRunning: () => false,
    ...overrides,
  };
}
