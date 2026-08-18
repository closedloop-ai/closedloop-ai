/**
 * @file required-plugin-installer-runtime-ready.test.ts
 * @description ISS-4428 regression tests: a required-plugin distribution the
 * installer deferred with `status:"pending", failureReason:"runtime not ready"`
 * must actually be retried once the runtime becomes ready.
 *
 * The bug: `reconcile()` only fired on cloud-online, so a distribution assigned
 * while the design-system runtime had not yet booted stayed `pending` forever
 * even though the runtime became ready seconds later. The app-level fix re-runs
 * `reconcile()` on the runtime-ready signal (in addition to cloud-online). These
 * tests exercise the installer contract that fix relies on:
 *   (a) the deferral is *retriable* — reported "pending" (not "failed") — so a
 *       later reconcile, once the runtime is ready, installs the pack;
 *   (b) a *permanent* failure is reported "failed", so it is distinguished from
 *       the transient deferral and never treated as retry-forever;
 *   (c) once the pack is installed, a subsequent reconcile is idempotent — no
 *       double-install.
 *
 * The runtime-ready transition is modeled by the injected `runInstall` /
 * `getInstalledVersion` callbacks flipping from not-ready to ready between
 * reconcile() calls — no sleeps, no wall-clock timing. Network is never touched
 * (shared fake fetch fixture).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RequiredPluginInstaller } from "../src/main/packs/required-plugin-installer.js";
import type { StreamRunResult } from "../src/shared/install-run-contract.js";
import {
  COMPUTE_TARGET_ID,
  deferred,
  makeAutoInstallDist,
  makeClientOptions,
  makeFakeFetch,
} from "./support/required-plugin-installer-fixtures.js";

describe("RequiredPluginInstaller runtime-ready retry (ISS-4428)", () => {
  test("a pending deferral installs once the runtime becomes ready on the next reconcile", async () => {
    const dist = makeAutoInstallDist();
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

    // The runtime is not ready for the first reconcile, then flips ready. This
    // models the wiring in required-plugin-installer-options.ts: while the
    // design-system runtime is null, runInstall resolves null (defer); once the
    // runtime has booted, getInstalledVersion reports "not installed" (null) and
    // runInstall actually runs.
    let runtimeReady = false;
    const installCalls: string[] = [];
    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: async () => null,
      runInstall: (packId) => {
        if (!runtimeReady) {
          return Promise.resolve(null);
        }
        installCalls.push(packId);
        return Promise.resolve({
          started: true,
          runId: 77,
        } satisfies StreamRunResult);
      },
    });

    // First reconcile (cloud-online, runtime not booted): deferral -> pending.
    await installer.reconcile(COMPUTE_TARGET_ID);
    assert.equal(
      installCalls.length,
      0,
      "runtime not ready yet, so no install"
    );
    assert.equal(statusBodies.length, 1);
    assert.equal(statusBodies[0].reports[0].status, "pending");
    assert.ok(
      statusBodies[0].reports[0].failureReason?.includes("runtime not ready")
    );

    // Runtime becomes ready; the runtime-ready signal re-runs reconcile.
    runtimeReady = true;
    await installer.reconcile(COMPUTE_TARGET_ID);

    assert.equal(installCalls.length, 1, "retry installs the deferred pack");
    assert.equal(installCalls[0], "rtk");
    assert.equal(statusBodies.length, 2);
    assert.equal(statusBodies[1].reports[0].status, "installed");
    assert.equal(statusBodies[1].reports[0].installRunId, "77");
  });

  test("a permanent failure is reported 'failed', not the retriable 'pending' deferral", async () => {
    // The transient-vs-permanent distinction the fix depends on: a real install
    // failure surfaces as "failed", never "pending". Only the runtime-not-ready
    // path (runInstall === null) is the retriable deferral; a permanent failure
    // is not disguised as one, so it is never retried-forever as if transient.
    const dist = makeAutoInstallDist();
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: async () => null,
      runInstall: async () =>
        ({
          started: false,
          error: {
            code: "CATALOG_NOT_FOUND",
            message: "pack not in catalog",
          },
        }) satisfies StreamRunResult,
    });

    await installer.reconcile(COMPUTE_TARGET_ID);

    assert.equal(statusBodies.length, 1);
    const report = statusBodies[0].reports[0];
    assert.equal(
      report.status,
      "failed",
      "a permanent failure must not be a retriable 'pending' deferral"
    );
    assert.notEqual(report.status, "pending");
  });

  test("no double-install: a reconcile after the pack is installed does not re-run runInstall", async () => {
    // After the runtime-ready retry installs the pack, the pack is present. A
    // subsequent reconcile (e.g. the later cloud-online one) must be idempotent:
    // getInstalledVersion now returns a version, so runInstall is never called
    // again — no double-install.
    const dist = makeAutoInstallDist();
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

    let installedVersion: string | null = null;
    const installCalls: string[] = [];
    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: async () => installedVersion,
      runInstall: (packId) => {
        installCalls.push(packId);
        // Model the install landing: the pack is now present.
        installedVersion = "1.0.0";
        return Promise.resolve({
          started: true,
          runId: 1,
        } satisfies StreamRunResult);
      },
    });

    // First reconcile installs (runtime ready, pack missing).
    await installer.reconcile(COMPUTE_TARGET_ID);
    // Second reconcile: pack already installed -> skip.
    await installer.reconcile(COMPUTE_TARGET_ID);

    assert.equal(installCalls.length, 1, "install must run exactly once");
    assert.equal(statusBodies.length, 2);
    assert.equal(statusBodies[0].reports[0].status, "installed");
    assert.equal(statusBodies[1].reports[0].status, "installed");
    assert.equal(
      statusBodies[1].reports[0].installedVersion,
      "1.0.0",
      "second reconcile reports the already-installed version, no re-install"
    );
  });
});

describe("RequiredPluginInstaller.notifyRuntimeReady lifecycle boundary (ISS-4428)", () => {
  test("the real runtime-ready path retries a deferred distribution and installs it", async () => {
    // Drives the ACTUAL readiness path the app wires: notifyRuntimeReady() reads
    // resolveRuntimeReadyTarget() to get the compute target and fires the
    // reconcile itself (fire-and-forget). This would break if
    // notifyRuntimeReady stopped calling reconcile or its resolve-target guard
    // were wrong — unlike a test that calls reconcile() directly.
    const dist = makeAutoInstallDist();
    const installed = deferred();
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist], {
      // The installed report is the 1st status POST (the runtime is ready on the
      // first and only reconcile this path drives).
      onStatusPosted: (count) => {
        if (count === 1) {
          installed.resolve();
        }
      },
    });

    const installCalls: string[] = [];
    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      // Runtime is ready by the time the catalog-seeded signal fires.
      resolveRuntimeReadyTarget: () => COMPUTE_TARGET_ID,
      getInstalledVersion: async () => null,
      runInstall: (packId) => {
        installCalls.push(packId);
        return Promise.resolve({
          started: true,
          runId: 55,
        } satisfies StreamRunResult);
      },
    });

    // Fire-and-forget, exactly as the onCatalogSeeded callback does.
    installer.notifyRuntimeReady();
    await installed.promise;

    assert.equal(installCalls.length, 1, "the deferred pack is installed");
    assert.equal(installCalls[0], "rtk");
    assert.equal(statusBodies.length, 1);
    assert.equal(statusBodies[0].reports[0].status, "installed");
    assert.equal(statusBodies[0].reports[0].installRunId, "55");
  });

  test("notifyRuntimeReady is a no-op when resolveRuntimeReadyTarget returns null (shutdown/offline)", async () => {
    // When the app is shutting down or offline, resolveRuntimeReadyTarget yields
    // null and notifyRuntimeReady must NOT touch the network or install path —
    // the guard the app relies on to avoid restarting a subsystem after disposal
    // and to avoid a reconcile with no live compute target.
    const dist = makeAutoInstallDist();
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

    let resolveTargetCalls = 0;
    const installCalls: string[] = [];
    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      resolveRuntimeReadyTarget: () => {
        resolveTargetCalls += 1;
        return null; // shutting down / offline
      },
      getInstalledVersion: async () => null,
      runInstall: (packId) => {
        installCalls.push(packId);
        return Promise.resolve({
          started: true,
          runId: 1,
        } satisfies StreamRunResult);
      },
    });

    installer.notifyRuntimeReady();
    // Let any (erroneously) scheduled microtasks flush.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(resolveTargetCalls, 1, "the guard predicate is consulted");
    assert.equal(installCalls.length, 0, "no install when target is null");
    assert.equal(statusBodies.length, 0, "no status POST when target is null");
  });

  test("a request arriving during the trailing pass does not spin the reconcile (bounded to one trailing pass)", async () => {
    // ISS-4428 bound: a reconcile requested mid-flight runs exactly ONE trailing
    // pass. A further request that lands *during* that trailing pass must be
    // dropped, not re-arm the drain — otherwise the GET/install/status loop runs
    // forever. We prove the bound by re-entering reconcile() from inside the
    // trailing pass's own getInstalledVersion and asserting the drain stops.
    const dist = makeAutoInstallDist();
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

    let doReconcilePasses = 0;
    let reentered = false;
    let installerRef: RequiredPluginInstaller | null = null;
    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      resolveRuntimeReadyTarget: () => COMPUTE_TARGET_ID,
      getInstalledVersion: () => {
        doReconcilePasses += 1;
        // On the FIRST (initial) pass, request another reconcile mid-flight —
        // this is the single legitimate trailing pass. The returned promise is
        // intentionally not awaited (models the fire-and-forget re-entry).
        if (doReconcilePasses === 1) {
          installerRef?.reconcile(COMPUTE_TARGET_ID).catch(() => {
            // ignored — fire-and-forget re-entry
          });
        }
        // On the SECOND pass (the trailing pass), request AGAIN. This must be
        // dropped by the bound, so there is never a third pass.
        if (doReconcilePasses === 2 && !reentered) {
          reentered = true;
          installerRef?.reconcile(COMPUTE_TARGET_ID).catch(() => {
            // ignored — fire-and-forget re-entry
          });
        }
        // already installed — keeps each pass side-effect-light
        return Promise.resolve("1.0.0");
      },
      runInstall: () =>
        Promise.resolve({ started: true, runId: 1 } satisfies StreamRunResult),
    });
    installerRef = installer;

    await installer.reconcile(COMPUTE_TARGET_ID);

    assert.equal(
      doReconcilePasses,
      2,
      "exactly one trailing pass: the mid-trailing-pass request is dropped, not a third pass"
    );
    // Both passes reported (already-installed), and the drain terminated.
    assert.equal(statusBodies.length, 2);
  });
});
