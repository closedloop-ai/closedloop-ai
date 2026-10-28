/**
 * @file required-plugin-installer-options.ts
 * @description Builds the {@link RequiredPluginInstallerOptions} the desktop app
 * wires into {@link RequiredPluginInstaller}, extracted out of the (grandfathered
 * oversized) `app.ts` so the opt-in-distribution integration lives in its owning
 * pack module. The factory takes narrow runtime accessors (getters, not values,
 * because the design-system runtime boots lazily) instead of the whole app
 * object, keeping the dependency surface explicit and unit-testable.
 *
 * FEA-2923 / FEA-4050.
 */

import type { DistributionDto } from "@repo/api/src/types/distribution";
import { toOptInDistributionDto } from "@repo/api/src/types/distribution";
import { DesktopRendererEventChannel } from "../../shared/desktop-renderer-event-channel.js";
import type { AgentDashboardDesignSystemRuntime } from "../dashboard/agent-dashboard-design-system-runtime.js";
import { reportDistributionInstallGaveUp } from "../telemetry/distribution-install-terminal-telemetry.js";
import type { DesktopWindow } from "../window.js";
import type {
  CoachingInstallOutcome,
  RequiredPluginInstallerOptions,
} from "./required-plugin-installer.js";
import {
  notifyTerminalInstallFailure,
  type TerminalInstallNotification,
  type TerminalInstallNotificationOptions,
} from "./terminal-install-notification.js";

/**
 * The opt-in broadcast channel. EXPORTED so a test asserts the sender's own
 * value rather than a copy of the string — a literal checked against another
 * literal pins nothing. The receiving `ipcRenderer.on`/`removeListener` pair in
 * `preload-design-system.ts` still spells it raw; pointing those at this symbol
 * is the follow-up that closes the sender/receiver gap.
 */
export const OPT_IN_AVAILABLE_CHANNEL =
  DesktopRendererEventChannel.DistributionsOptInAvailable;

/**
 * Narrow accessor surface the installer options close over. All runtime values
 * (the design-system runtime, the window) are read through getters so a lazily-
 * booted or torn-down runtime is observed at call time, never captured stale.
 */
export type RequiredPluginInstallerOptionsParams = {
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string;
  /** The design-system runtime, or null while it has not yet booted. */
  getDesignSystemRuntime: () => AgentDashboardDesignSystemRuntime | null;
  /**
   * ISS-4428: resolves the compute target for a runtime-ready retry, or `null`
   * to skip (shutting down, or offline with no live compute target). The
   * installer reads this from `notifyRuntimeReady()` so the runtime-ready retry
   * policy lives in the installer, not in the app entrypoint.
   */
  resolveRuntimeReadyTarget: () => string | null;
  /** Coaching-pack install (download/extract/validate/activate). */
  installCoachingDistribution: (
    dist: DistributionDto
  ) => Promise<CoachingInstallOutcome>;
  /** Live window for the opt-in-available broadcast. */
  getWindow: () => DesktopWindow;
  /**
   * The settings store, narrowed to the three reads/writes this module makes.
   * A structural port rather than three hand-written adapter arrows at the call
   * site: `SettingsStore` satisfies it as-is, and every member is still read at
   * call time, so a Labs toggle flipped after boot takes effect without a
   * relaunch.
   */
  settings: RequiredPluginInstallerSettingsPort;
  /** ISS-6170: OS notification factory, injected as elsewhere in main. */
  createNotification: (
    options: TerminalInstallNotificationOptions
  ) => TerminalInstallNotification;
};

/**
 * The settings surface the installer options depend on. Deliberately the
 * smallest shape that compiles against `SettingsStore`, so this module cannot
 * quietly grow a dependency on the whole store.
 */
export type RequiredPluginInstallerSettingsPort = {
  /** FEA-4050 durable decline suppression check (compute-target scoped). */
  isDistributionDeclined(
    distributionId: string,
    computeTargetId: string
  ): boolean;
  /** FEA-4050 durable decline persistence sink. */
  recordDeclinedDistribution(record: {
    distributionId: string;
    catalogItemId: string;
    organizationId: string;
    computeTargetId: string;
  }): void;
  /**
   * ISS-6170: reads the `terminalInstallFailureNotifications` Labs toggle. It
   * gates ONLY the user-facing notification — the monitored telemetry give-up is
   * not a UI surface and is never gated, because an operator who left the toggle
   * off must still not lose the signal.
   */
  getFlag(key: "terminalInstallFailureNotifications"): boolean;
};

export function buildRequiredPluginInstallerOptions(
  params: RequiredPluginInstallerOptionsParams
): RequiredPluginInstallerOptions {
  return {
    distributionsClient: {
      getAccessToken: params.getAccessToken,
      getApiOrigin: params.getApiOrigin,
    },
    resolveRuntimeReadyTarget: params.resolveRuntimeReadyTarget,
    // runInstall: vetted catalog-path install via the design-system runtime's
    // installPack() (same streamRun path the renderer catalog-install IPC uses).
    // Install commands come ONLY from the local vetted pack_catalog row resolved
    // by packId — cloud commands and the presigned zip URL are NEVER a source.
    // Returns null only while the runtime has not booted, so the installer
    // defers ("pending") and retries on the next cloud online transition.
    runInstall: (packId, harness) => {
      const runtime = params.getDesignSystemRuntime();
      if (!runtime) {
        return Promise.resolve(null);
      }
      return runtime.installPack(packId, harness);
    },
    // getInstalledVersion: reads the installed pack version from the local
    // agent_packs inventory. Null while the runtime is not ready (same deferral)
    // or when the pack is not installed (interpreted as "needs install").
    getInstalledVersion: (packId) => {
      const runtime = params.getDesignSystemRuntime();
      if (!runtime) {
        return Promise.resolve(null);
      }
      return runtime.getInstalledPackVersion(packId);
    },
    installCoachingDistribution: params.installCoachingDistribution,
    onOptInAvailable: (distributions) => {
      // Surface opt-in distributions to the renderer via IPC. Project each DTO
      // down to the renderer-safe fields (FEA-3043) — never broadcast the live
      // presigned `assetDownloadUrl`; the renderer installs by id and main
      // re-resolves the asset by id, never trusting renderer asset data.
      params
        .getWindow()
        .sendToRenderer(
          OPT_IN_AVAILABLE_CHANNEL,
          distributions.map(toOptInDistributionDto)
        );
    },
    clearOptInSnapshot: () => {
      params.getWindow().clearRendererSnapshot(OPT_IN_AVAILABLE_CHANNEL);
    },
    // FEA-4050: suppress an opt-in pack the user has durably declined so the
    // reconcile does not re-push it on the next app restart. Scoped by compute
    // target; keyed on the distribution assignment id, so an admin re-share (new
    // id) is still surfaced and another profile's decline does not suppress this.
    isDistributionDeclined: (distributionId, computeTargetId) =>
      params.settings.isDistributionDeclined(distributionId, computeTargetId),
    // FEA-4050: durably persist a decline recorded via the renderer's
    // `declineDistribution` bridge. Identity is resolved cloud-authoritatively
    // inside `declineDistributionById`, never from renderer-supplied data.
    recordDeclinedDistribution: (record) =>
      params.settings.recordDeclinedDistribution(record),
    // ISS-6170: both sinks hang off this because a give-up nothing reports is
    // indistinguishable from an install that worked — but they want DIFFERENT
    // cadences, which is what `firstGiveUp` carries.
    //
    // Telemetry runs on EVERY raise. It self-latches per error code, and only
    // once the lane actually accepted the event, so the repeats are what let a
    // give-up raised while the authenticated HTTP lane was still coming up
    // eventually land instead of being dropped for good.
    //
    // The notification runs on the FIRST raise only. It interrupts a human, so
    // a repeat is not a retry, it is nagging about something they already saw.
    onTerminalInstallFailure: (notice) => {
      reportDistributionInstallGaveUp(notice.code);
      if (
        notice.firstGiveUp &&
        params.settings.getFlag("terminalInstallFailureNotifications")
      ) {
        notifyTerminalInstallFailure(params.createNotification, notice.reason);
      }
    },
  };
}
