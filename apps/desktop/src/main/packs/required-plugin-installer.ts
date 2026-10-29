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

import {
  type DistributionDto,
  DistributionMode,
  type DistributionStatusReport,
} from "@repo/api/src/types/distribution";
import { dropOnDbHostLifecycleError } from "../../shared/db-host-fire-and-forget.js";
import {
  classifyStreamRunRetry,
  HARNESS_AUTO,
  StreamRunErrorCode,
  type StreamRunResult,
  StreamRunRetryClass,
} from "../../shared/install-run-contract.js";
import { normalizePackId } from "../../shared/normalize-pack-id.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  type DistributionsClientOptions,
  getAssignedDistributions,
  reportDistributionStatus,
} from "./distributions-client.js";
import { TerminalInstallLatch } from "./terminal-install-latch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RequiredPluginInstallerOptions = {
  /** First-party session fetch options (token + API origin). */
  distributionsClient: DistributionsClientOptions;
  /**
   * ISS-4428: resolves the compute target for a runtime-ready-triggered retry,
   * or `null` when a retry must be skipped (the app is shutting down, or the
   * cloud is offline so there is no live compute target to reconcile against).
   * Injected so the installer — not the app entrypoint — owns the whole
   * runtime-ready retry policy; {@link RequiredPluginInstaller.notifyRuntimeReady}
   * reads it. Optional so existing wiring/tests that never drive a runtime-ready
   * retry can omit it.
   */
  resolveRuntimeReadyTarget?: () => string | null;
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
  /** Drop the retained opt-in snapshot after an accept or decline action. */
  clearOptInSnapshot?: () => void;
  /**
   * FEA-4050: durable "has the user already declined this opt-in pack?" check.
   * Reads the settings-store declined list so a pack the user dismissed stays
   * suppressed across app restarts (the decline is no longer only the banner's
   * in-memory `handledIds`). Scoped by `(distributionId, computeTargetId)` so a
   * decline recorded under one user/profile does not suppress the same org
   * distribution for a different user/profile after an account switch, and a
   * genuinely-new re-share (a new `distributionId`) is still surfaced. When
   * omitted, no suppression is applied (older wiring / tests).
   */
  isDistributionDeclined?: (
    distributionId: string,
    computeTargetId: string
  ) => boolean;
  /**
   * FEA-4050: durably persist a decline. Called by
   * {@link RequiredPluginInstaller.declineDistributionById} with the full
   * cloud-authoritative identity (distribution + catalog item + org) resolved
   * from the assigned-distributions response, never renderer-supplied data.
   * `computeTargetId` scopes the decision to the acting user/profile.
   */
  recordDeclinedDistribution?: (record: {
    distributionId: string;
    catalogItemId: string;
    organizationId: string;
    computeTargetId: string;
  }) => void;
  /**
   * ISS-6170: called on every reconcile that skips a pack the installer has
   * given up on, with `firstGiveUp` true only on the reconcile that latched it.
   * Sinks own their own cadence from that flag. Wired by
   * {@link ../packs/required-plugin-installer-options.js} to the monitored
   * telemetry lane and the (Labs-gated) user notification. A give-up that
   * reported nothing would be indistinguishable from an install that succeeded,
   * so the sinks are part of the give-up, not decoration on it. Optional for
   * wiring/tests that do not observe it.
   */
  onTerminalInstallFailure?: (notice: TerminalInstallFailureNotice) => void;
};

/**
 * One pack this build has proved it can never install, reported at the moment
 * the installer latches it. `code` is the producer's own closed error code, so
 * a sink can branch on the condition without parsing `reason`.
 */
export type TerminalInstallFailureNotice = {
  packId: string;
  distributionId: string;
  code: StreamRunErrorCode;
  reason: string;
  /**
   * True only on the reconcile that latched this pack. A sink that must reach
   * the user exactly once reads this; a sink that must keep trying until it is
   * delivered ignores it.
   */
  firstGiveUp: boolean;
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
 * Best-effort: a PERMANENTLY failed install logs an ERROR (ISS-5027 — it used to
 * warn, which made two silent back-to-back failures indistinguishable from
 * routine noise) while a retryable one stays at warn; either way it records
 * `failed` status without blocking other distributions or throwing.
 */
export class RequiredPluginInstaller {
  private readonly opts: RequiredPluginInstallerOptions;
  private reconcileInFlight = false;
  /**
   * ISS-4428: compute target of a reconcile that was requested while one was
   * already in flight. A trigger that lands mid-reconcile (e.g. the
   * runtime-ready signal arriving during the cloud-online reconcile that just
   * deferred everything with "runtime not ready") would otherwise be dropped by
   * the in-flight guard and never retried, leaving the pack `pending` until the
   * next cloud-online. Instead we coalesce: remember the latest requested target
   * and run exactly ONE more reconcile after the current one drains.
   *
   * The bound is enforced by {@link trailingPassDone}: only requests that arrive
   * during the *initial* reconcile are honored as the single trailing pass. Any
   * request that lands *during that trailing pass* is dropped, so the drain can
   * never repopulate itself into an unbounded GET/install/status loop. Repeat
   * requests during the initial pass overwrite this (latest target wins); they
   * do not stack.
   */
  private pendingReconcileTargetId: string | null = null;
  /**
   * ISS-4428 bound guard. Set once the single trailing pass has been consumed
   * for the current drain, so a request arriving *while* that trailing pass runs
   * cannot re-arm {@link pendingReconcileTargetId} and spin the loop. Reset when
   * the whole reconcile chain drains (back to not-in-flight).
   */
  private trailingPassDone = false;
  /**
   * ISS-6170: pack ids this build has already proved it cannot install. Consulted
   * before every `runInstall` so a permanent failure costs one attempt per
   * process instead of one per reconcile — `reconcile()` fires on every
   * cloud-online transition and on runtime-ready, which is how a single
   * uninstallable pack produced 24 identical error lines in one log window.
   */
  private readonly terminalLatch = new TerminalInstallLatch();
  /**
   * ISS-6170 × ISS-4428: has the local `pack_catalog` seed landed in this
   * process yet? Until it has, `ENOTFOUND` does NOT mean "absent from this
   * build's catalog" — on a fresh database the catalog is populated by deferred
   * startup maintenance, and `reconcile()` also fires on the cloud-online
   * transition, which does not wait for it. Latching that pre-seed miss would
   * defeat the very retry ISS-4428 added (`onCatalogSeeded` →
   * {@link notifyRuntimeReady}) and leave a legitimately installable pack dead
   * for the life of the process. So nothing latches until this flips.
   */
  private catalogSeeded = false;

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
    this.opts.clearOptInSnapshot?.();
    this.publishOptInSnapshot(distributions, computeTargetId, distributionId);
    return outcome;
  }

  /**
   * ISS-5123: re-assert that a distribution is still assigned, immediately
   * before the renderer installs it.
   *
   * The opt-in banner holds rows pushed by an earlier reconcile. An admin can
   * withdraw a pack at any point after that push, and the renderer has no way to
   * know: the withdrawal only removes the row from the NEXT assignment poll, and
   * a reconcile runs on cloud-online and runtime-ready, not on a timer. Without
   * this check a stale row stays actionable and installs a pack the org has
   * already stopped offering.
   *
   * Deliberately re-fetches rather than consulting anything cached — the whole
   * point is to ask the authority. Rejects (rather than returning a boolean) so
   * a caller cannot accidentally treat the failure as "assigned"; the message
   * matches the coaching accept path, which has always revalidated this way.
   */
  async assertDistributionAssigned(
    computeTargetId: string,
    distributionId: string
  ): Promise<void> {
    const distributions = await getAssignedDistributions(
      this.opts.distributionsClient,
      computeTargetId
    );
    if (!distributions.some((d) => d.id === distributionId)) {
      throw new Error("Distribution is no longer assigned.");
    }
  }

  /**
   * Refresh the retained opt-in snapshot after a generic catalog install.
   * The catalog install IPC knows only the pack id, so the banner acknowledges
   * its distribution id after the install succeeds. Snapshot invalidation is
   * synchronous; the authoritative refresh is best-effort.
   */
  async acknowledgeOptInHandled(
    computeTargetId: string | null,
    distributionId: string
  ): Promise<void> {
    this.opts.clearOptInSnapshot?.();
    if (!computeTargetId) {
      return;
    }
    try {
      const distributions = await getAssignedDistributions(
        this.opts.distributionsClient,
        computeTargetId
      );
      this.publishOptInSnapshot(distributions, computeTargetId, distributionId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      gatewayLog.warn(
        "required-plugin-installer",
        `distribution ${distributionId}: handled snapshot refresh failed: ${message}`
      );
    }
  }

  /**
   * FEA-4050: renderer-initiated durable decline of an opt-in distribution. The
   * opt-in banner calls this (via the `declineDistribution` IPC bridge) when the
   * user dismisses a pack, so the decline survives an app restart instead of
   * living only in the banner's in-memory `handledIds`.
   *
   * Durability contract: the decline is persisted from the `distributionId`
   * BEFORE the cloud re-fetch, then the cloud-authoritative audit fields
   * (catalog item + org) are enriched in a second write. Suppression keys on
   * `distributionId` alone, so the offer is already durably suppressed the
   * instant the user dismisses it — a quit (or a pending/timed-out lookup)
   * between the two writes cannot lose the decline or let the pack reappear on
   * the next launch. The enrich re-fetches the assigned distributions the SAME
   * way the accept path does, so the recorded identity is cloud-authoritative,
   * never renderer-supplied. A distribution that is no longer assigned keeps its
   * id-only record (the offer is gone; suppress it if it ever returns under the
   * same id).
   *
   * Best-effort: if no `recordDeclinedDistribution` sink is wired, this is a
   * no-op (the renderer still suppresses the row for the current session).
   */
  async declineDistributionById(
    computeTargetId: string,
    distributionId: string
  ): Promise<void> {
    this.opts.clearOptInSnapshot?.();
    const record = this.opts.recordDeclinedDistribution;
    if (!record) {
      return;
    }

    // 1. Persist the decline id-first, synchronously, before any await. This is
    //    the durability guarantee: even if the process quits during the cloud
    //    lookup below, the pack stays suppressed across restarts. Scoped to the
    //    acting compute target so it never suppresses another user/profile.
    record({
      distributionId,
      catalogItemId: "",
      organizationId: "",
      computeTargetId,
    });

    // 2. Enrich the audit fields (catalog item + org) from the authoritative
    //    cloud response. Upsert-by-distributionId means this refreshes the
    //    record in place; a failed re-fetch (offline / transient) leaves the
    //    id-only record intact — no decline is lost.
    let catalogItemId = "";
    let organizationId = "";
    try {
      const distributions = await getAssignedDistributions(
        this.opts.distributionsClient,
        computeTargetId
      );
      this.publishOptInSnapshot(distributions, computeTargetId, distributionId);
      const dist = distributions.find((d) => d.id === distributionId);
      if (!dist) {
        return;
      }
      catalogItemId = dist.catalogItemId;
      organizationId = dist.organizationId;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      gatewayLog.warn(
        "required-plugin-installer",
        `distribution ${distributionId}: decline audit re-resolve failed, keeping id-only record: ${msg}`
      );
      return;
    }

    record({ distributionId, catalogItemId, organizationId, computeTargetId });
  }

  /**
   * ISS-4428: retry deferred required-plugin distributions once the
   * design-system runtime has become ready. The auto-install path defers with
   * `status:"pending", failureReason:"runtime not ready"` when the runtime is
   * not yet available; before this that deferral was only retried on the next
   * cloud-online transition, so a distribution assigned while offline (or before
   * the runtime finished booting) stayed `pending` forever. This drives a
   * reconcile on runtime-ready to close that gap.
   *
   * This is the fire-and-forget lifecycle entry point owned by the installer
   * (rather than a policy block in the app entrypoint): it is best-effort and
   * NEVER rejects, so the runtime-boot continuation that calls it cannot produce
   * an unhandled rejection (which in the desktop main process would exit the
   * app). It self-guards via {@link RequiredPluginInstallerOptions.resolveRuntimeReadyTarget}
   * — a `null` target means "skip" (shutting down, or offline with no live
   * compute target), so app.ts passes only that predicate, not the retry policy.
   * {@link reconcile} already coalesces against an in-flight reconcile and bounds
   * itself to a single trailing pass, so this cannot fan out.
   */
  notifyRuntimeReady(): void {
    // ISS-6170: this signal IS the catalog-seeded signal (app.ts wires it to the
    // runtime's `onCatalogSeeded`), so record it BEFORE the skip check below. The
    // seed is a fact about the local database; whether we can reconcile against
    // the cloud right now is a separate question, and letting a shutdown or an
    // offline moment discard it would keep the installer permanently unable to
    // recognise a genuinely uninstallable pack.
    this.catalogSeeded = true;
    const computeTargetId = this.opts.resolveRuntimeReadyTarget?.() ?? null;
    if (computeTargetId === null) {
      return;
    }
    this.reconcile(computeTargetId).catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      gatewayLog.warn(
        "required-plugin-installer",
        `runtime-ready reconcile failed (best-effort, will retry on next cloud online): ${msg}`
      );
    });
  }

  /**
   * ISS-8776 — start a reconcile from a caller that has no error path.
   *
   * `reconcile` reaches the db-host early and OUTSIDE any try:
   * `doReconcile` → `processAutoInstall` → `opts.getInstalledVersion(packId)`,
   * which is wired to a `packStore.getPack` read. Launched with a bare `void`
   * from the cloud-online transition, a db-host child that died under that read
   * reached `handleUnhandledRejection`, which shows the crash dialog and calls
   * `app.exit(1)` — the app lost to a store bounce that happened to coincide
   * with a reconnect.
   *
   * Uses the ONE fire-and-forget contract rather than a bare `.catch`, so a
   * db-host lifecycle failure is dropped with a log (the next cloud-online
   * transition reconciles again) while a genuine installer bug stays exactly as
   * loud as it is today.
   */
  reconcileInBackground(computeTargetId: string): void {
    dropOnDbHostLifecycleError(this.reconcile(computeTargetId), {
      label: "required-plugin reconcile",
      log: (message) => gatewayLog.warn("required-plugin-installer", message),
    });
  }

  /**
   * Fetch and process assigned distributions. Safe to call on every cloud
   * online event and on the runtime-ready signal — re-entrant calls coalesce
   * (one reconcile at a time; see the ISS-4428 trailing-pass bound below).
   */
  async reconcile(computeTargetId: string): Promise<void> {
    if (this.reconcileInFlight) {
      // ISS-4428: don't drop a request that lands mid-reconcile — remember it
      // (latest target wins) and run ONE trailing pass once the current one
      // drains. This is what lets a runtime-ready trigger retry a "runtime not
      // ready" deferral even when it races the in-flight cloud-online reconcile.
      //
      // Bound: once the single trailing pass has been consumed for this drain
      // (`trailingPassDone`), a request arriving *during* that trailing pass is
      // dropped rather than re-arming the slot — otherwise the drain could keep
      // repopulating itself into an unbounded GET/install/status loop.
      if (!this.trailingPassDone) {
        this.pendingReconcileTargetId = computeTargetId;
      }
      return;
    }
    this.reconcileInFlight = true;
    this.trailingPassDone = false;
    try {
      await this.doReconcile(computeTargetId);
      // Drain at most ONE coalesced follow-up requested while the initial
      // reconcile was running. Consuming it sets `trailingPassDone`, so any
      // request that lands during this trailing pass is dropped (see above) and
      // the drain is provably bounded to a single trailing pass per entry.
      const nextTargetId = this.pendingReconcileTargetId;
      this.pendingReconcileTargetId = null;
      this.trailingPassDone = true;
      if (nextTargetId !== null) {
        await this.doReconcile(nextTargetId);
      }
    } finally {
      this.reconcileInFlight = false;
      this.trailingPassDone = false;
    }
  }

  private async doReconcile(computeTargetId: string): Promise<void> {
    const distributions = await getAssignedDistributions(
      this.opts.distributionsClient,
      computeTargetId
    );

    const autoInstall = distributions.filter(
      (distribution) => distribution.mode === DistributionMode.AutoInstall
    );

    // Surface opt-in distributions to the renderer as an authoritative SNAPSHOT
    // of what the org currently offers — including the empty one.
    //
    // ISS-5123: this used to be withheld unless the set was non-empty, which made
    // withdrawal unenforceable on an already-open banner. The renderer replaces
    // its pending set from this payload, so "no longer in the payload" is how an
    // offer is revoked; skipping the push on empty (the exact shape produced by
    // withdrawing the last opt-in pack) would leave the revoked row on screen and
    // actionable forever.
    this.publishOptInSnapshot(distributions, computeTargetId);

    if (distributions.length === 0) {
      return;
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

  /** Publish the current filtered opt-in set through the configured delivery path. */
  private publishOptInSnapshot(
    distributions: DistributionDto[],
    computeTargetId: string,
    handledDistributionId?: string
  ): void {
    const isDeclined = this.opts.isDistributionDeclined;
    const optInToSurface = distributions.filter(
      (distribution) =>
        distribution.mode === DistributionMode.OptIn &&
        distribution.id !== handledDistributionId &&
        !isDeclined?.(distribution.id, computeTargetId)
    );
    this.opts.onOptInAvailable?.(optInToSurface);
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

    // ISS-6170: this build already proved it cannot install this pack. Keep
    // telling the cloud the device did not converge — a give-up that stopped
    // reporting would look exactly like a success — but do not re-run the
    // identical failing request, and do not re-log it. The one error line and
    // the one give-up signal were raised on the reconcile that latched it.
    const latched = this.terminalLatch.recordFor(packId);
    if (latched !== undefined) {
      // Re-raised, not returned silently: the monitored sink does not consume
      // its one report until the telemetry lane ACCEPTED it, and that lane can
      // be closed when the latch fires. `firstGiveUp: false` keeps the
      // once-only sinks quiet.
      this.opts.onTerminalInstallFailure?.({
        code: latched.code,
        distributionId: dist.id,
        firstGiveUp: false,
        packId,
        reason: latched.reason,
      });
      return {
        distributionId: dist.id,
        status: "failed",
        failureReason: latched.reason,
      };
    }

    // Invoke the install callback. The caller (app.ts) provides this callback
    // and it must source install commands ONLY from vetted local pack_catalog
    // rows via streamRun — never from raw cloud-supplied commands.
    // ISS-5027: the sentinel, resolved by `streamRun` for EVERY pack class (it
    // used to resolve only for `single_install` packs, which made this whole
    // path unreachable for anything else).
    let result: StreamRunResult | null;
    try {
      result = await this.opts.runInstall(packId, HARNESS_AUTO);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      gatewayLog.error(
        "required-plugin-installer",
        `distribution ${dist.id}: install of '${packId}' FAILED — runInstall threw: ${msg}`
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
      const reason = describeNotStarted(packId, result);
      // ISS-5027: a PERMANENT failure is logged at error, not warn. A
      // distribution that can never install is a real failure the admin who
      // pushed the pack needs to see; at warn it was indistinguishable from
      // routine deferral noise, which is how two back-to-back failures went
      // unnoticed. The `failed` status below already tells the cloud; this is
      // the local record — gateway log panel plus the persistent main.log — that
      // matches it. It is not itself wired to an external alert.
      //
      // A TRANSIENT code (no CLI on PATH yet, another run in flight) stays at
      // warn. `reconcile()` fires on every cloud-online transition and on
      // runtime-ready, so promoting those would emit a fresh error on every
      // reconnect for a user who simply has not installed the CLI — recreating
      // the same noise problem, inverted. The retry axis comes from the
      // producer's own canonical classification, so this level and the convert
      // engine's retry decision cannot drift apart.
      const code = result.error?.code;
      // Equivalent to classifying `result.error?.code` directly — an absent code
      // classifies transient — but written so `code` is narrowed for the latch.
      const permanent =
        code !== undefined &&
        classifyStreamRunRetry(code) === StreamRunRetryClass.Permanent;
      if (permanent) {
        gatewayLog.error(
          "required-plugin-installer",
          `distribution ${dist.id}: install of '${packId}' FAILED — ${reason}`
        );
        // ISS-4428: NOT before the catalog seed has landed. A pre-seed
        // `ENOTFOUND` says the local catalog is still empty, not that this build
        // lacks the pack, and the seed's own callback drives the retry that
        // fixes it — latching there would turn the ordinary fresh-install
        // ordering into a pack that can never install until a relaunch.
        if (
          this.catalogSeeded &&
          this.terminalLatch.latch(packId, { code, reason })
        ) {
          this.opts.onTerminalInstallFailure?.({
            code,
            distributionId: dist.id,
            firstGiveUp: true,
            packId,
            reason,
          });
        }
      } else {
        gatewayLog.warn(
          "required-plugin-installer",
          `distribution ${dist.id}: install of '${packId}' could not start yet (retryable) — ${reason}`
        );
      }
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

/**
 * ISS-5027: turn a non-started `streamRun` result into a reason an operator can
 * act on, rather than the bare orchestrator text.
 *
 * `ENOTFOUND` is the version-skew case: cloud distributed a pack id that this
 * desktop build's compiled-in catalog seed does not contain, so no amount of
 * retrying helps and the admin needs to know the team never received it. Per
 * the cross-repo compatibility contract we degrade gracefully — the reconcile
 * keeps going and other distributions still install — but the failure stays
 * legible instead of being swallowed. Every other code keeps the orchestrator's
 * own message, which is already user-actionable (missing CLI, bad cwd, …).
 */
function describeNotStarted(packId: string, result: StreamRunResult): string {
  const message = result.error?.message ?? "install did not start";
  if (result.error?.code === StreamRunErrorCode.NotFound) {
    return `pack '${packId}' is not in this desktop build's catalog — this build cannot install it (update Closedloop Desktop, or the distribution references a pack that no longer exists): ${message}`;
  }
  return message;
}
