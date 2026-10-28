import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  hasRecordedSyncConsent,
  type SyncConsentRecord,
} from "../../shared/sync-consent.js";
import type { DesktopOtelRuntime } from "../telemetry/app-otel-runtime.js";
import {
  type AgentSessionSyncCapabilities,
  syncCapabilityAccessors,
} from "./agent-session-sync-capabilities.js";
import type { AgentSessionSyncSource } from "./agent-session-sync-source.js";
import type {
  DesktopSyncLaneDeps,
  SyncLaneSessionManager,
} from "./desktop-sync-lane-composition.js";
import type { ComputeTargetRefusalReason } from "./retained-compute-target-identity.js";

/**
 * @file desktop-sync-lane-deps.ts
 * @description ISS-8768 — assembles the {@link DesktopSyncLaneDeps} the desktop
 * app hands `createDesktopSyncLanes`, extracted out of the (grandfathered
 * oversized) `app.ts` per AGENTS.md → "File Size and Organization", the same
 * seam `required-plugin-installer-options.ts` already took out of that file.
 *
 * The unit is the whole live-state surface the lanes re-read on every tick.
 * It takes the collaborators the app already owns as narrow structural PORTS
 * rather than a dozen hand-written `() => this.x.y()` arrows at the call site,
 * so the dependency surface is explicit, the wiring is unit-testable without
 * booting an Electron app, and — the property the lanes actually depend on —
 * every member still resolves at CALL time. Nothing here is snapshotted: a
 * collaborator that boots late (the dashboard runtime), is replaced mid-session
 * (the transcript lane), or changes answer (consent, identity, capabilities) is
 * observed live, which is exactly what the inline arrows guaranteed.
 */

/**
 * The settings surface the lane deps read. Deliberately the smallest shape that
 * `SettingsStore` satisfies structurally, so this module cannot quietly grow a
 * dependency on the whole store.
 */
export type SyncLaneSettingsPort = {
  getApiOrigin(): string;
  /**
   * ISS-8768: key PRESENCE, not the collapsed egress verdict. Kept distinct
   * from `sessionMetadataAllowed` on purpose — see `laneDeliveryConsented`.
   */
  hasSyncObservabilityTierBeenSet(): boolean;
  getDataSyncLevel(): DataSyncLevel;
  getSyncConsentRecord(): SyncConsentRecord;
};

/** The compute-target/readiness slice of the session-sync identity adapter. */
export type SyncLaneIdentityPort = {
  computeTargetId(): string | null;
  /**
   * ISS-11467: why the last {@link computeTargetId} refused a live id. Part of the
   * port rather than read off the concrete adapter, because the id and the reason
   * it was refused are one answer and a caller that could get one without the other
   * would report a refusal that describes a different read.
   */
  lastLiveTargetRefusal(): ComputeTargetRefusalReason | null;
  isHttpReady(): boolean;
};

/** The collaborators the composition root already owns as fields. */
export type DesktopSyncLaneDepsParams = {
  desktopSessionManager: SyncLaneSessionManager;
  settings: SyncLaneSettingsPort;
  sessionSyncIdentity: SyncLaneIdentityPort;
  syncEgressGate: {
    sessionMetadataAllowed(): boolean;
  };
  rendererGates: { waitForRendererBackgroundSlot(): Promise<void> };
  appOtelRuntime: DesktopOtelRuntime;
  getApiKey: () => string | null;
  /** Read live: the socket renegotiates these on every hello ack. */
  getServerCapabilities: () => AgentSessionSyncCapabilities;
  getTranscriptComputeTargetId: () => string | null;
  /** The Agent Dashboard runtime, or null until it boots. */
  getDashboardRuntime: () => {
    syncSource: AgentSessionSyncSource | null;
    isInitialSessionProjectionReady(): boolean;
  } | null;
  /** The transcript archive lane, or null while its gate is shut. */
  getTranscriptSync: () => { isRunning(): boolean } | null;
  /**
   * ISS-9166: forwarded verbatim. Absent for the app, which is what keeps the
   * `worker_threads` preparer; see the field on {@link DesktopSyncLaneDeps}.
   */
  preparePayloads?: DesktopSyncLaneDeps["preparePayloads"];
  /**
   * ISS-9166: forwarded verbatim. Absent for the app; see the field on
   * {@link DesktopSyncLaneDeps}.
   */
  onSyncBurndownSample?: DesktopSyncLaneDeps["onSyncBurndownSample"];
  /**
   * ISS-11426: forwarded verbatim, so the application can share ONE latch with
   * the transcript lane; see the field on {@link DesktopSyncLaneDeps}.
   */
  computeTargetLinkBlock?: DesktopSyncLaneDeps["computeTargetLinkBlock"];
};

export function buildDesktopSyncLaneDeps(
  params: DesktopSyncLaneDepsParams
): DesktopSyncLaneDeps {
  const { settings, desktopSessionManager, sessionSyncIdentity } = params;
  const hasRecordedChoice = () =>
    hasRecordedSyncConsent(
      settings.getSyncConsentRecord(),
      desktopSessionManager.getIdentity()?.organizationId ?? null
    );
  return {
    desktopSessionManager,
    preparePayloads: params.preparePayloads,
    onSyncBurndownSample: params.onSyncBurndownSample,
    computeTargetLinkBlock: params.computeTargetLinkBlock,
    getApiKey: params.getApiKey,
    getApiOrigin: () => settings.getApiOrigin(),
    getTranscriptComputeTargetId: params.getTranscriptComputeTargetId,
    getSyncComputeTargetId: () => sessionSyncIdentity.computeTargetId(),
    // ISS-11467: read AFTER `getSyncComputeTargetId` by every consumer, because the
    // resolver records the reason as a side effect of resolving. Both come from the
    // one adapter so the refusal cannot describe a different read than the id does.
    getComputeTargetRefusal: () => sessionSyncIdentity.lastLiveTargetRefusal(),
    isSessionMetadataSyncTierAllowed: () =>
      params.syncEgressGate.sessionMetadataAllowed(),
    hasSyncObservabilityTierBeenSet: () =>
      settings.hasSyncObservabilityTierBeenSet(),
    getDataSyncLevel: () => settings.getDataSyncLevel(),
    hasRecordedSyncConsent: hasRecordedChoice,
    isHttpAgentSessionSyncReady: () =>
      sessionSyncIdentity.isHttpReady() && hasRecordedChoice(),
    isInitialSessionProjectionReady: () =>
      params.getDashboardRuntime()?.isInitialSessionProjectionReady() ?? false,
    ...syncCapabilityAccessors(params.getServerCapabilities),
    getSyncSource: () => params.getDashboardRuntime()?.syncSource ?? null,
    waitForBackgroundSlot: () =>
      params.rendererGates.waitForRendererBackgroundSlot(),
    appOtelRuntime: params.appOtelRuntime,
    isTranscriptSyncRunning: () =>
      params.getTranscriptSync()?.isRunning() ?? false,
  };
}
