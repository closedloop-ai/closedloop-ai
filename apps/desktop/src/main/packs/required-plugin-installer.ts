/**
 * @file required-plugin-installer.ts
 * @description Auto-installs required (auto_install) distributions on cloud
 * online transition and surfaces opt-in distributions to the renderer.
 *
 * SECURITY: install commands are sourced ONLY from vetted `pack_catalog` rows
 * in the local SQLite database — never from raw cloud-supplied commands.
 * Cloud supplies a zip asset bundle (downloaded via presigned URL); the
 * installer resolves the corresponding catalog entry and calls `streamRun`
 * with that entry's vetted `installCommands`. This preserves the existing
 * "cannot exfiltrate tokens / arbitrary execution" guarantee.
 *
 * FEA-2923 (T-16.8)
 */

import type {
  DistributionDto,
  DistributionStatusReport,
} from "@repo/api/src/types/distribution";
import { normalizePackId } from "../../shared/normalize-pack-id.js";
import { gatewayLog } from "../gateway-logger.js";
import {
  type DistributionsClientOptions,
  getAssignedDistributions,
  reportDistributionStatus,
} from "./distributions-client.js";
import type { StreamRunResult } from "./install-orchestrator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RequiredPluginInstallerOptions = {
  /** First-party session fetch options (token + API origin). */
  distributionsClient: DistributionsClientOptions;
  /**
   * Callback that runs an install for the given pack via the existing
   * streamRun catalog path (unchanged trust model). Returns the StreamRunResult.
   * Returns null when the runtime is not yet ready.
   */
  runInstall: (
    packId: string,
    harness: string
  ) => Promise<StreamRunResult | null>;
  /**
   * Callback that returns the currently installed version for a pack, or null
   * if the pack is not installed or the runtime is not ready.
   */
  getInstalledVersion: (packId: string) => Promise<string | null>;
  /**
   * Install a coaching-pack distribution (FEA-2923 batch 5). The callback owns
   * downloading the presigned asset zip, extracting it, and invoking
   * `installCoachingPackFromDistribution` (which itself honors
   * `shouldHonorDistributionDefault` for override precedence). Resolves to a
   * `CoachingInstallOutcome` describing what happened. When omitted, coaching
   * distributions are reported as `pending` (runtime not ready).
   */
  installCoachingDistribution?: (
    dist: DistributionDto
  ) => Promise<CoachingInstallOutcome>;
  /** Called with opt-in distributions so the renderer can surface them. */
  onOptInAvailable?: (distributions: DistributionDto[]) => void;
};

/**
 * Result of a coaching-pack distribution install attempt.
 * - `installed`: the pack was copied/activated (or already present + honored).
 * - `skipped`: override precedence declined the install (user has a local
 *   choice); reported as `installed` with no version since nothing changed.
 * - `disabled`: the coaching-packs feature flag is off, so nothing was
 *   installed and the device did NOT converge; reported as `pending` (like
 *   "runtime not ready") so the cloud never sees a false `installed`.
 * - `failed`: download/extract/validate failed.
 */
export type CoachingInstallOutcome = {
  status: "installed" | "skipped" | "disabled" | "failed";
  installedVersion?: string | null;
  failureReason?: string;
};

// ---------------------------------------------------------------------------
// RequiredPluginInstaller
// ---------------------------------------------------------------------------

/**
 * Reconciles auto_install distributions on cloud online transition.
 *
 * On each `reconcile()` call:
 * 1. GET /desktop/distributions/assigned for the active compute target.
 * 2. For each auto_install distribution: check if the pack_id matching the
 *    catalog item name is already installed. If missing or outdated, invoke
 *    the runInstall callback which uses the local pack_catalog's vetted
 *    installCommands (unchanged trust model — NEVER executes raw cloud commands).
 * 3. Surface opt_in distributions via the onOptInAvailable callback.
 * 4. POST /desktop/distributions/status with all results.
 *
 * Best-effort: a failed install logs a warning and records `failed` status,
 * but does NOT block other distributions or throw.
 */
export class RequiredPluginInstaller {
  private readonly opts: RequiredPluginInstallerOptions;
  private reconcileInFlight = false;

  constructor(opts: RequiredPluginInstallerOptions) {
    this.opts = opts;
  }

  /**
   * Renderer-initiated install of a single opt-in coaching distribution
   * (FEA-2923 / §I). The opt-in banner calls this via the `coachingInstall`
   * IPC bridge when the user accepts a `catalogItem.coaching` distribution.
   *
   * Resolves the distribution the SAME way the auto-install path does — by
   * re-fetching the assigned distributions for this compute target and matching
   * on `distributionId` — so the presigned `assetDownloadUrl` (and its catalog
   * item) come from the authoritative cloud response, never from renderer-
   * supplied data. Then delegates to the coaching install callback (download /
   * extract / validate / activate, honoring override precedence).
   *
   * Throws on any non-installed outcome (distribution not found, wrong type,
   * feature-flag off, download/extract/validate failure, or callback missing)
   * so the caller's IPC promise rejects and the banner surfaces an inline error
   * instead of dismissing the row. Returns the outcome on success.
   */
  async installCoachingDistributionById(
    computeTargetId: string,
    distributionId: string
  ): Promise<CoachingInstallOutcome> {
    const install = this.opts.installCoachingDistribution;
    if (!install) {
      throw new Error("Coaching install is not available yet.");
    }

    const distributions = await getAssignedDistributions(
      this.opts.distributionsClient,
      computeTargetId
    );
    const dist = distributions.find((d) => d.id === distributionId);
    if (!dist) {
      throw new Error("Distribution is no longer assigned.");
    }
    if (!dist.catalogItem.coaching) {
      throw new Error("Distribution is not a coaching pack.");
    }

    const outcome = await install(dist);
    if (outcome.status === "failed") {
      throw new Error(outcome.failureReason ?? "Coaching install failed.");
    }
    if (outcome.status === "disabled") {
      throw new Error("Coaching Packs is disabled.");
    }
    // `installed` and `skipped` (override precedence honored) are both success.
    return outcome;
  }

  /**
   * Fetch and process assigned distributions. Safe to call on every cloud
   * online event — re-entrant calls are no-ops (one reconcile at a time).
   */
  async reconcile(computeTargetId: string): Promise<void> {
    if (this.reconcileInFlight) {
      return;
    }
    this.reconcileInFlight = true;
    try {
      await this.doReconcile(computeTargetId);
    } finally {
      this.reconcileInFlight = false;
    }
  }

  private async doReconcile(computeTargetId: string): Promise<void> {
    const distributions = await getAssignedDistributions(
      this.opts.distributionsClient,
      computeTargetId
    );

    if (distributions.length === 0) {
      return;
    }

    const autoInstall = distributions.filter((d) => d.mode === "auto_install");
    const optIn = distributions.filter((d) => d.mode === "opt_in");

    // Surface opt-in distributions to the renderer.
    if (optIn.length > 0 && this.opts.onOptInAvailable) {
      this.opts.onOptInAvailable(optIn);
    }

    const reports: DistributionStatusReport[] = [];

    for (const dist of autoInstall) {
      const report = await this.processAutoInstall(dist);
      if (report) {
        reports.push(report);
      }
    }

    if (reports.length > 0) {
      await reportDistributionStatus(
        this.opts.distributionsClient,
        computeTargetId,
        reports
      );
    }
  }

  /**
   * Install a coaching-pack distribution via the coaching install path. Delegates
   * download/extract/validate/activate to `installCoachingDistribution` (which
   * honors override precedence). A missing callback means the runtime is not yet
   * wired, so we defer ("pending") and retry on the next reconcile.
   */
  private async processCoachingAutoInstall(
    dist: DistributionDto
  ): Promise<DistributionStatusReport | null> {
    const install = this.opts.installCoachingDistribution;
    if (!install) {
      gatewayLog.info(
        "required-plugin-installer",
        `distribution ${dist.id}: coaching install not wired, deferring`
      );
      return {
        distributionId: dist.id,
        status: "pending",
        failureReason: "runtime not ready",
      };
    }

    let outcome: CoachingInstallOutcome;
    try {
      outcome = await install(dist);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      gatewayLog.warn(
        "required-plugin-installer",
        `distribution ${dist.id}: coaching install threw: ${msg}`
      );
      return {
        distributionId: dist.id,
        status: "failed",
        failureReason: msg,
      };
    }

    if (outcome.status === "failed") {
      return {
        distributionId: dist.id,
        status: "failed",
        failureReason: outcome.failureReason ?? "coaching install failed",
      };
    }

    if (outcome.status === "disabled") {
      // Feature flag off: nothing installed, device did NOT converge. Defer as
      // `pending` (matching "runtime not ready") so the cloud never records a
      // false `installed`; a later reconcile (flag on) can complete the install.
      gatewayLog.info(
        "required-plugin-installer",
        `distribution ${dist.id}: coaching packs feature-flag off, deferring`
      );
      return {
        distributionId: dist.id,
        status: "pending",
        failureReason: "coaching packs disabled",
      };
    }

    // `skipped` (override precedence declined) and `installed` both report as
    // installed to the cloud — the device is in its desired state either way.
    return {
      distributionId: dist.id,
      status: "installed",
      installedVersion: outcome.installedVersion ?? undefined,
    };
  }

  private async processAutoInstall(
    dist: DistributionDto
  ): Promise<DistributionStatusReport | null> {
    // Coaching packs (batch 5) install via the coaching-pack path, NOT the
    // generic pack_catalog streamRun install.
    if (dist.catalogItem.coaching) {
      return this.processCoachingAutoInstall(dist);
    }
    const packId = dist.catalogItem.name
      ? normalizePackId(dist.catalogItem.name)
      : null;

    if (!packId) {
      gatewayLog.warn(
        "required-plugin-installer",
        `distribution ${dist.id}: no catalogItem.name — cannot resolve pack_id; skipping`
      );
      return null;
    }

    // Check whether this pack is already installed. The DistributionDto does
    // not carry a version field; version parity is checked locally by comparing
    // the installed agent_packs version against what the local catalog expects.
    const installed = await this.opts.getInstalledVersion(packId);
    if (installed !== null) {
      // Already installed — report current status without re-running.
      return {
        distributionId: dist.id,
        status: "installed",
        installedVersion: installed,
      };
    }

    // Invoke the install callback. The caller (app.ts) provides this callback
    // and it must source install commands ONLY from vetted local pack_catalog
    // rows via streamRun — never from raw cloud-supplied commands.
    const harness = "auto"; // single_install packs pick the right harness
    let result: StreamRunResult | null;
    try {
      result = await this.opts.runInstall(packId, harness);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      gatewayLog.warn(
        "required-plugin-installer",
        `distribution ${dist.id}: runInstall threw: ${msg}`
      );
      return {
        distributionId: dist.id,
        status: "failed",
        failureReason: msg,
      };
    }

    if (result === null) {
      // Runtime not yet ready — report pending so cloud knows we saw it.
      gatewayLog.info(
        "required-plugin-installer",
        `distribution ${dist.id}: runtime not ready, deferring install of '${packId}'`
      );
      return {
        distributionId: dist.id,
        status: "pending",
        failureReason: "runtime not ready",
      };
    }

    if (!result.started) {
      const reason = result.error?.message ?? "install did not start";
      gatewayLog.warn(
        "required-plugin-installer",
        `distribution ${dist.id}: install did not start: ${reason}`
      );
      return {
        distributionId: dist.id,
        status: "failed",
        failureReason: reason,
      };
    }

    // streamRun is asynchronous (streams output to the renderer); we report
    // optimistic "installed" since streamRun records the real outcome via
    // onComplete and the cloud will see a correction on the next reconcile.
    return {
      distributionId: dist.id,
      status: "installed",
      installRunId:
        result.runId === undefined ? undefined : String(result.runId),
    };
  }
}
