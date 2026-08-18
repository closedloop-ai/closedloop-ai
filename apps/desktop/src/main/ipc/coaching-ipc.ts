import type { CoachingPackInfo } from "../../shared/coaching-pack-contract.js";
import { DistributionsIpcChannel } from "../../shared/distributions-channel.js";
import {
  generateCoachingTips,
  installCoachingArtifact,
} from "../agent-monitor/agent-coaching-harness.js";
import { installCoachingPack } from "../agent-monitor/agent-coaching-packs.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

export const CoachingIpcChannel = {
  Generate: "desktop:agent-coaching:generate",
  Install: "desktop:agent-coaching:install",
  GetPack: "desktop:agent-coaching:get-pack",
  InstallPack: "desktop:agent-coaching:install-pack",
  // Opt-in distribution channels are single-sourced in the shared
  // distributions-channel contract so the preload cannot drift from the handler.
  CoachingInstall: DistributionsIpcChannel.CoachingInstall,
  // FEA-4050: durably record a decline of an org-distributed opt-in pack so the
  // reconcile no longer re-surfaces it after an app restart.
  DistributionDecline: DistributionsIpcChannel.Decline,
  // ISS-5123: pre-install revalidation for a withdrawn-but-still-on-screen offer.
  DistributionEnsureAssigned: DistributionsIpcChannel.EnsureAssigned,
} as const;

export type CoachingIpcChannel =
  (typeof CoachingIpcChannel)[keyof typeof CoachingIpcChannel];

type IpcMainLike = {
  handle: (
    channel: CoachingIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type CoachingIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  isAgentCoachingTipsEnabled: () => boolean;
  isCoachingPacksEnabled: () => boolean;
  getActiveCoachingPackSeeded: () => CoachingPackInfo | null;
  coachingPacksDir: () => string;
  getTraceCommentComputeTargetId: () => string | null;
  installCoachingDistributionById: (
    computeTargetId: string,
    distributionId: string
  ) => Promise<unknown>;
  /**
   * FEA-4050: durably persist a decline of an opt-in distribution. Resolves the
   * distribution identity cloud-authoritatively by id (never from renderer
   * data) and records it in the settings store so the reconcile suppresses it
   * across restarts. Records the decline id-first before the cloud lookup, so a
   * quit or timed-out lookup mid-decline cannot lose it.
   */
  declineDistributionById: (
    computeTargetId: string,
    distributionId: string
  ) => Promise<void>;
  /**
   * FEA-4050: persist a decline from the `distributionId` alone, with empty
   * audit fields. Used on the not-connected (no compute target) path where the
   * cloud identity cannot be resolved: the pack the banner already surfaced must
   * still be suppressed across restarts, otherwise the reconcile re-surfaces it
   * the moment the cloud reconnects. Suppression keys on `distributionId`, so an
   * id-only record is fully durable; the audit fields backfill on the next
   * connected decline (if any).
   */
  recordDeclinedDistributionId: (distributionId: string) => void;
  /**
   * ISS-5123: re-assert against the cloud that a distribution is still assigned.
   * Rejects when it is not, so the renderer's generic accept path cannot install
   * a pack the org has withdrawn since the banner row was pushed.
   */
  assertDistributionAssigned: (
    computeTargetId: string,
    distributionId: string
  ) => Promise<void>;
};

export function registerCoachingIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: CoachingIpcDeps
): void {
  // Coaching tip generation + artifact install run through the local agent
  // harness (no cloud); see agent-coaching-harness.ts.
  ipcMainLike.handle(CoachingIpcChannel.Generate, async (event, prompt) => {
    // `prompt` is fed straight into the local LLM harness and drives
    // `runHarnessOnce("claude", …)` — a spawned host process with hooks
    // enabled. Sender trust is the boundary that keeps a compromised/secondary
    // renderer from injecting coaching prompts that drive host-side tool calls,
    // matching the Install / InstallPack / CoachingInstall siblings. Assert
    // before the try/catch so an untrusted sender rejects the IPC rather than
    // being swallowed into an `ok:false` result.
    assertTrustedIpcSender(deps.isTrustedSender, event);
    if (!deps.isAgentCoachingTipsEnabled()) {
      gatewayLog.info(
        "agent-coaching",
        "generate skipped because Agent Coaching Tips is disabled"
      );
      return { ok: true, output: "[]" };
    }
    // `prompt` is renderer-supplied; the renderer contract types it as a string.
    // generateCoachingTips resolves to a structured result and does not throw for
    // an operational failure (timeout / spawn error / non-zero exit). We still
    // wrap defensively so an UNEXPECTED throw never reaches Electron's
    // `ipcMain.handle` as an "Error occurred in handler" surfaced to the user —
    // the coaching UI renders a clean fallback for any `ok:false` result.
    try {
      const result = await generateCoachingTips(prompt as string);
      if (result.ok) {
        gatewayLog.info(
          "agent-coaching",
          `generate output preview: ${result.output.slice(0, 200).replaceAll("\n", " ")}`
        );
      } else {
        gatewayLog.warn(
          "agent-coaching",
          `generate failed (${result.reason}): ${result.message}`
        );
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      gatewayLog.error(
        "agent-coaching",
        `generate threw unexpectedly — ${message}`
      );
      return { ok: false, reason: "spawn_failed", message };
    }
  });
  ipcMainLike.handle(
    CoachingIpcChannel.Install,
    // `harness` is renderer-supplied and validated inside the harness module
    // before any spawn — never trust it as a binary name here. The `draft`
    // text is fed straight into the local LLM harness prompt, so sender trust
    // is the boundary that keeps a compromised/secondary renderer from
    // injecting coaching prompts that drive host-side tool calls.
    async (event, draft, harness, kind) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (!deps.isAgentCoachingTipsEnabled()) {
        return {
          ok: false as const,
          reason: "spawn_failed" as const,
          message: "Agent Coaching Tips is disabled.",
        };
      }
      // Like Generate, the install harness resolves to a structured result and
      // never rejects for an operational failure — return it directly so the
      // renderer surfaces a clean install-failed state, not a raw handler error.
      // `kind` (FEA-3687 #4) selects the deterministic new-file install vs the
      // LLM-driven edit-existing path; it is validated (defaulted) in the
      // harness module, so an untrusted value can never mis-route.
      try {
        return await installCoachingArtifact(draft as string, harness, kind);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        gatewayLog.error(
          "agent-coaching",
          `install threw unexpectedly — ${message}`
        );
        return { ok: false as const, reason: "spawn_failed" as const, message };
      }
    }
  );
  // The active coaching pack supplies the best-practice signals that REPLACE
  // the built-in defaults. Bundled packs are seeded into userData on first
  // access; the renderer treats null as "use built-in defaults".
  ipcMainLike.handle(CoachingIpcChannel.GetPack, () => {
    // Gate before seeding: when the packs flag is off, nothing touches disk
    // and the renderer falls back to the built-in signals.
    if (!deps.isCoachingPacksEnabled()) {
      return null;
    }
    return deps.getActiveCoachingPackSeeded();
  });
  // Install an external coaching pack folder (the "distribution method"):
  // copy it into the managed store and make it active. User-initiated folder
  // pick → local copy; the pack is validated before anything lands on disk.
  ipcMainLike.handle(CoachingIpcChannel.InstallPack, (event, sourceDir) => {
    // Gate before any disk work: the handler copies a renderer-supplied
    // directory into the managed coaching-packs store and makes it active,
    // controlling best-practice signals. Path canonicalization and manifest
    // validation in installCoachingPack are defense-in-depth — sender trust
    // is the boundary that keeps a compromised/secondary renderer out.
    assertTrustedIpcSender(deps.isTrustedSender, event);
    if (!deps.isCoachingPacksEnabled()) {
      throw new Error("Coaching Packs is disabled.");
    }
    if (typeof sourceDir !== "string" || sourceDir.length === 0) {
      throw new Error("install-pack requires a source directory path.");
    }
    return installCoachingPack(sourceDir, deps.coachingPacksDir());
  });
  // Renderer-initiated opt-in coaching distribution install (FEA-2923 / §I).
  // The opt-in banner calls `window.desktopApi.db.coachingInstall(dist.id)`
  // when the user accepts a coaching-pack distribution. We resolve the
  // distribution (and its presigned asset) from the authoritative cloud
  // response by id — never trusting renderer-supplied asset data — then run
  // the same coaching install path the headless auto-installer uses. Rejects
  // on any non-installed outcome so the banner surfaces an inline error.
  ipcMainLike.handle(
    CoachingIpcChannel.CoachingInstall,
    (event, distributionId) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (!deps.isCoachingPacksEnabled()) {
        throw new Error("Coaching Packs is disabled.");
      }
      if (typeof distributionId !== "string" || distributionId.length === 0) {
        throw new Error("coachingInstall requires a distribution id.");
      }
      const computeTargetId = deps.getTraceCommentComputeTargetId();
      if (!computeTargetId) {
        throw new Error("Not connected — cannot resolve the distribution.");
      }
      return deps.installCoachingDistributionById(
        computeTargetId,
        distributionId
      );
    }
  );
  // FEA-4050: durable decline of an opt-in distribution. The opt-in banner
  // calls `window.desktopApi.db.declineDistribution(dist.id)` when the user
  // dismisses a pack. We persist the decline so the reconcile suppresses it
  // across restarts. Unlike CoachingInstall this is NOT gated on the
  // coaching-packs flag — a decline applies to every opt-in pack kind
  // (plugin/skill/command/coaching).
  //
  // Durability first: the `distributionId` is what the reconcile suppression
  // keys on, so we persist it BEFORE any cloud work. When connected, we then
  // resolve the cloud-authoritative audit fields (catalog item + org) and
  // enrich the record. When NOT connected (no compute target) we still record
  // the id-only decline — the banner already surfaced this pack, so if we
  // skipped persistence the reconcile would re-surface it the instant the cloud
  // reconnects, exactly the reappear-after-restart bug this fixes. Resolves
  // (never rejects) so a dismiss click is never surfaced as a handler error.
  ipcMainLike.handle(
    CoachingIpcChannel.DistributionDecline,
    (event, distributionId) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (typeof distributionId !== "string" || distributionId.length === 0) {
        throw new Error("declineDistribution requires a distribution id.");
      }
      const computeTargetId = deps.getTraceCommentComputeTargetId();
      if (!computeTargetId) {
        // Not connected: persist the id-only decline durably now; the cloud
        // audit fields backfill on the next connected decline (if any).
        gatewayLog.info(
          "distributions",
          `decline of ${distributionId} recorded id-only — not connected (no compute target)`
        );
        deps.recordDeclinedDistributionId(distributionId);
        return Promise.resolve();
      }
      return deps.declineDistributionById(computeTargetId, distributionId);
    }
  );
  // ISS-5123: the opt-in banner calls this immediately before installing a
  // GENERIC (plugin/skill/command) distribution. That accept path resolves a
  // local pack id from renderer-held state and never touches the cloud, so
  // without this an offer withdrawn after the banner row was pushed would still
  // install. The coaching accept path already revalidates inside
  // `installCoachingDistributionById`, so it does not route through here.
  //
  // Fail CLOSED: not connected means we cannot confirm the offer still stands,
  // and a destructive-to-trust "install anyway" is the wrong default — reject so
  // the banner surfaces an inline error and keeps the row.
  ipcMainLike.handle(
    CoachingIpcChannel.DistributionEnsureAssigned,
    (event, distributionId) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (typeof distributionId !== "string" || distributionId.length === 0) {
        throw new Error(
          "ensureDistributionAssigned requires a distribution id."
        );
      }
      const computeTargetId = deps.getTraceCommentComputeTargetId();
      if (!computeTargetId) {
        throw new Error("Not connected — cannot confirm the distribution.");
      }
      return deps.assertDistributionAssigned(computeTargetId, distributionId);
    }
  );
}
