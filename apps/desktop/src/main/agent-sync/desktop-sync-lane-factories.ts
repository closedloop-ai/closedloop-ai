/**
 * @file desktop-sync-lane-factories.ts
 * @description Construction for the sync lane the app owns directly — the
 * transcript archive lane — extracted out of the (grandfathered oversized)
 * `app.ts` per AGENTS.md → "File Size and Organization", the same seam
 * `desktop-sync-lane-deps.ts` already took out of that file.
 *
 * `app.ts` owns the lane's LIFECYCLE — the `start`/`stop` calls on the
 * unconditional boot path — and this module owns the wiring behind it. The
 * other lanes are composed in `desktop-sync-lane-composition.ts`.
 *
 * It takes the app's collaborators as narrow structural PORTS rather than a
 * dozen hand-written `() => this.x.y()` arrows at the call site, exactly as
 * `buildDesktopSyncLaneDeps` does. Nothing is snapshotted: every member below
 * resolves at CALL time, because the dashboard runtime boots late, the compute
 * target changes on reconnect, and the consent tier changes live.
 */

import { DesktopAuthStatus } from "../../shared/contracts.js";
import type { TranscriptEgressGate } from "../../shared/transcript-sync-status-contract.js";
import type { AgentDashboardDesignSystemRuntime } from "../dashboard/agent-dashboard-design-system-runtime.js";
import { createDesktopTranscriptSyncService } from "../transcript-sync/desktop-transcript-sync-factory.js";
import { resolveDesktopTranscriptStateDir } from "../transcript-sync/transcript-state-dir.js";
import type { TranscriptSyncService } from "../transcript-sync/transcript-sync-service.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import type { SyncLaneSessionManager } from "./desktop-sync-lane-composition.js";

/** The settings the transcript lane reads, live on every call. */
export type TranscriptLaneSettingsPort = {
  getApiOrigin(): string;
  getTranscriptSyncEnabled(): boolean;
};

/** The consent-tier gate, in both the boolean and tri-state forms the lane needs. */
export type TranscriptLaneEgressPort = {
  transcriptAllowed(): boolean;
  transcriptGate(): TranscriptEgressGate;
};

export type TranscriptLaneParams = {
  desktopSessionManager: SyncLaneSessionManager & {
    getState(): { status: DesktopAuthStatus };
    getIdentity: () => SignedInUserIdentity | null;
  };
  settings: TranscriptLaneSettingsPort;
  syncEgressGate: TranscriptLaneEgressPort;
  getAgentDashboardRuntime: () => AgentDashboardDesignSystemRuntime | null;
  getComputeTargetId: () => string | null;
};

/** Assemble the transcript archive lane (FEA-2715) from the app's collaborators. */
export function createTranscriptSyncLane(
  params: TranscriptLaneParams
): TranscriptSyncService {
  const { desktopSessionManager, settings, syncEgressGate } = params;
  return createDesktopTranscriptSyncService({
    getAccessToken: () => desktopSessionManager.getAccessToken(),
    getApiOrigin: () => settings.getApiOrigin(),
    invalidateAccessToken: (rejectedToken) =>
      desktopSessionManager.invalidateAccessToken(rejectedToken),
    stateDir: resolveDesktopTranscriptStateDir(),
    getAgentDashboardRuntime: params.getAgentDashboardRuntime,
    getComputeTargetId: params.getComputeTargetId,
    isTranscriptSyncEnabled: () => settings.getTranscriptSyncEnabled(),
    isTranscriptSyncTierAllowed: () => syncEgressGate.transcriptAllowed(),
    getTranscriptSyncTierGate: () => syncEgressGate.transcriptGate(),
    hasDesktopSessionAuth: () =>
      desktopSessionManager.getState().status ===
      DesktopAuthStatus.Authenticated,
    getSyncIdentity: () => desktopSessionManager.getIdentity(),
  });
}
