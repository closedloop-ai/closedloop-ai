/**
 * @file required-plugin-installer.test.ts
 * @description Unit tests for RequiredPluginInstaller (T-18.5 / AC-021, AC-024, AC-025).
 *
 * Verifies:
 *   (1) Missing plugin → install spawned via catalog streamRun path.
 *   (2) Outdated (version mismatch → getInstalledVersion returns null) → install spawned.
 *   (3) Already-current (installed) → no spawn; reports "installed".
 *   (4) Install command comes ONLY from the pack_catalog row (the runInstall callback
 *       receives packId derived from catalogItem.name, NOT the raw assetDownloadUrl from
 *       the cloud payload) — the critical trust-boundary assertion.
 *   (5) Status POSTed with correct distributionId / status / installRunId.
 *   (6) No-op when offline (getAccessToken returns null → getAssignedDistributions
 *       returns []).
 *   (7) Failed install is best-effort: does not throw, reports status="failed".
 *   (8) opt_in distributions are surfaced via onOptInAvailable and not installed.
 *   (9) Re-entrant reconcile() calls are serialised (in-flight guard).
 *
 * Network is never touched. A fake fetch intercepts the two HTTP calls:
 *   GET /desktop/distributions/assigned  → canned DistributionDto[]
 *   POST /desktop/distributions/status    → 200 OK
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DistributionDto } from "@repo/api/src/types/distribution";
import { RequiredPluginInstaller } from "../src/main/packs/required-plugin-installer.js";
import type { StreamRunResult } from "../src/shared/install-run-contract.js";
import {
  COMPUTE_TARGET_ID,
  makeAutoInstallDist,
  makeClientOptions,
  makeFakeFetch,
  makeOptInDist,
} from "./support/required-plugin-installer-fixtures.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const NO_LONGER_ASSIGNED_ERROR = /no longer assigned/;

describe("RequiredPluginInstaller", () => {
  describe("(1) missing plugin → install spawned", () => {
    test("calls runInstall when getInstalledVersion returns null", async () => {
      const dist = makeAutoInstallDist();
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

      const installCalls: Array<{ packId: string; harness: string }> = [];
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: (packId, harness) => {
          installCalls.push({ packId, harness });
          return Promise.resolve({
            started: true,
            runId: 42,
          } satisfies StreamRunResult);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(installCalls.length, 1, "runInstall must be called once");
      // The packId must be the normalized catalogItem.name ("RTK" → "rtk"),
      // NOT the assetDownloadUrl or any other cloud-supplied raw command.
      assert.equal(installCalls[0].packId, "rtk");
      assert.equal(installCalls[0].harness, "auto");

      // Status reported as installed with installRunId.
      assert.equal(statusBodies.length, 1);
      assert.equal(statusBodies[0].reports.length, 1);
      assert.equal(statusBodies[0].reports[0].distributionId, "dist-001");
      assert.equal(statusBodies[0].reports[0].status, "installed");
      assert.equal(statusBodies[0].reports[0].installRunId, "42");
    });
  });

  describe("(2) outdated plugin → update spawned", () => {
    test("re-installs when getInstalledVersion returns null (outdated signals re-install)", async () => {
      // When the caller determines the local version is outdated it returns null
      // to force a re-install. The installer treats null as "needs install".
      const dist = makeAutoInstallDist({
        catalogItem: {
          id: "ci-002",
          targetKind: "plugin",
          name: "GStack",
          source: "curated",
        },
        id: "dist-002",
      });
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

      const installCalls: string[] = [];
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        // Return null to simulate the caller deciding the local version is outdated.
        getInstalledVersion: async () => null,
        runInstall: (packId) => {
          installCalls.push(packId);
          return Promise.resolve({
            started: true,
            runId: 7,
          } satisfies StreamRunResult);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(installCalls.length, 1);
      assert.equal(installCalls[0], "gstack");
      assert.equal(statusBodies[0].reports[0].status, "installed");
      assert.equal(statusBodies[0].reports[0].installRunId, "7");
    });
  });

  describe("(3) already-current → no spawn", () => {
    test("skips runInstall and reports installed when getInstalledVersion returns a version string", async () => {
      const dist = makeAutoInstallDist();
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

      const installCalls: string[] = [];
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => "1.2.3",
        runInstall: (packId) => {
          installCalls.push(packId);
          return Promise.resolve({ started: true } satisfies StreamRunResult);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(installCalls.length, 0, "runInstall must NOT be called");
      assert.equal(statusBodies.length, 1);
      assert.equal(statusBodies[0].reports[0].distributionId, "dist-001");
      assert.equal(statusBodies[0].reports[0].status, "installed");
      assert.equal(statusBodies[0].reports[0].installedVersion, "1.2.3");
    });
  });

  describe("(4) trust-boundary: install command from pack_catalog only, never cloud payload", () => {
    test("runInstall receives packId derived from catalogItem.name, never the assetDownloadUrl", async () => {
      const dist = makeAutoInstallDist({
        catalogItem: {
          id: "ci-001",
          targetKind: "plugin",
          name: "RTK",
          source: "curated",
        },
        assetDownloadUrl:
          "https://s3.example.com/presigned/rtk.zip?token=DO-NOT-EXECUTE",
      });
      const { fetch: fakeFetch } = makeFakeFetch([dist]);

      let receivedArgs: { packId: string; harness: string } | null = null;
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: (packId, harness) => {
          receivedArgs = { packId, harness };
          return Promise.resolve({ started: true } satisfies StreamRunResult);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.ok(receivedArgs, "runInstall must have been called");
      // CRITICAL: packId must be derived from catalogItem.name, not assetDownloadUrl
      assert.equal(receivedArgs!.packId, "rtk");
      // CRITICAL: harness is the generic "auto" sentinel, not a raw cloud command
      assert.equal(receivedArgs!.harness, "auto");
      // CRITICAL: the assetDownloadUrl must NOT appear in any argument
      const argsString = JSON.stringify(receivedArgs);
      assert.ok(
        !argsString.includes("DO-NOT-EXECUTE"),
        "assetDownloadUrl must never be passed to runInstall"
      );
      assert.ok(
        !argsString.includes("s3.example.com"),
        "S3 URL must never reach the install callback"
      );
    });

    test("runInstall packId is normalized from catalogItem.name, not derived from assetDownloadUrl path", async () => {
      // Even with a very different S3 path, the pack id comes from the name.
      const dist = makeAutoInstallDist({
        catalogItem: {
          id: "ci-x",
          targetKind: "plugin",
          name: "Web Command Enablement Pack",
          source: "curated",
        },
        assetDownloadUrl:
          "https://s3.aws.com/bucket/org/catalog/ci-x/completely-different-filename.zip",
      });
      const { fetch: fakeFetch } = makeFakeFetch([dist]);

      let receivedPackId: string | null = null;
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: (packId) => {
          receivedPackId = packId;
          return Promise.resolve({ started: true } satisfies StreamRunResult);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      // Normalized from "Web Command Enablement Pack" → "web-command-enablement-pack"
      assert.equal(receivedPackId, "web-command-enablement-pack");
      assert.ok(
        !receivedPackId!.includes("s3"),
        "S3 URL must not appear in packId"
      );
    });
  });

  describe("(5) status POST with correct fields", () => {
    test("status body contains distributionId, status, and installRunId", async () => {
      const dist = makeAutoInstallDist({ id: "dist-xyz" });
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: async () =>
          ({ started: true, runId: 99 }) satisfies StreamRunResult,
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(statusBodies.length, 1);
      const report = statusBodies[0].reports[0];
      assert.equal(report.distributionId, "dist-xyz");
      assert.equal(report.status, "installed");
      assert.equal(report.installRunId, "99");
      assert.equal(statusBodies[0].computeTargetId, COMPUTE_TARGET_ID);
    });

    test("status body contains installedVersion when already installed", async () => {
      const dist = makeAutoInstallDist({ id: "dist-abc" });
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => "2.0.0",
        runInstall: async () => ({ started: true }),
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(statusBodies.length, 1);
      const report = statusBodies[0].reports[0];
      assert.equal(report.distributionId, "dist-abc");
      assert.equal(report.status, "installed");
      assert.equal(report.installedVersion, "2.0.0");
    });
  });

  describe("(6) no-op when offline / unauthenticated", () => {
    test("does not call runInstall when getAccessToken returns null (offline/unauthenticated)", async () => {
      // When getAccessToken returns null, getAssignedDistributions returns [] and
      // the reconcile is a no-op — no install, no status POST.
      const dist = makeAutoInstallDist();
      // Provide a fake fetch that would record calls if they happened.
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

      const installCalls: string[] = [];
      const installer = new RequiredPluginInstaller({
        // Simulate offline / unauthenticated state via unauthenticated=false
        distributionsClient: makeClientOptions(fakeFetch, false),
        getInstalledVersion: async () => null,
        runInstall: (packId) => {
          installCalls.push(packId);
          return Promise.resolve({ started: true });
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(
        installCalls.length,
        0,
        "runInstall must not be called offline"
      );
      assert.equal(
        statusBodies.length,
        0,
        "status POST must not be sent offline"
      );
    });
  });

  describe("(7) failed install is best-effort", () => {
    test("does not throw and reports status=failed when runInstall throws", async () => {
      const dist = makeAutoInstallDist();
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: () => Promise.reject(new Error("spawn failed: ENOENT")),
      });

      // Must not throw.
      await assert.doesNotReject(() => installer.reconcile(COMPUTE_TARGET_ID));

      assert.equal(statusBodies.length, 1);
      const report = statusBodies[0].reports[0];
      assert.equal(report.distributionId, "dist-001");
      assert.equal(report.status, "failed");
      assert.ok(
        report.failureReason?.includes("spawn failed"),
        "failureReason must contain error message"
      );
    });

    test("does not throw and reports status=failed when started=false", async () => {
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

      await assert.doesNotReject(() => installer.reconcile(COMPUTE_TARGET_ID));

      assert.equal(statusBodies.length, 1);
      const report = statusBodies[0].reports[0];
      assert.equal(report.status, "failed");
      assert.ok(report.failureReason?.includes("pack not in catalog"));
    });

    test("best-effort: one failed install does not block other distributions", async () => {
      const distFail = makeAutoInstallDist({
        id: "dist-fail",
        catalogItem: {
          id: "ci-f",
          targetKind: "plugin",
          name: "BadPack",
          source: "org_custom",
        },
      });
      const distOk = makeAutoInstallDist({
        id: "dist-ok",
        catalogItem: {
          id: "ci-ok",
          targetKind: "plugin",
          name: "GoodPack",
          source: "curated",
        },
      });
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([
        distFail,
        distOk,
      ]);

      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: (packId) => {
          if (packId === "badpack") {
            return Promise.reject(new Error("install failed"));
          }
          return Promise.resolve({
            started: true,
            runId: 5,
          } satisfies StreamRunResult);
        },
      });

      await assert.doesNotReject(() => installer.reconcile(COMPUTE_TARGET_ID));

      assert.equal(statusBodies.length, 1);
      const reports = statusBodies[0].reports;
      assert.equal(reports.length, 2);

      const failReport = reports.find((r) => r.distributionId === "dist-fail");
      const okReport = reports.find((r) => r.distributionId === "dist-ok");
      assert.ok(failReport, "failed distribution must have a report");
      assert.ok(okReport, "successful distribution must have a report");
      assert.equal(failReport!.status, "failed");
      assert.equal(okReport!.status, "installed");
    });
  });

  describe("(8) opt-in distributions surfaced, not installed", () => {
    test("opt_in distributions are passed to onOptInAvailable and NOT installed", async () => {
      const optIn = makeOptInDist();
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([optIn]);

      const optInReceived: DistributionDto[][] = [];
      const installCalls: string[] = [];

      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: (packId) => {
          installCalls.push(packId);
          return Promise.resolve({ started: true });
        },
        onOptInAvailable: (dists) => {
          optInReceived.push(dists);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(installCalls.length, 0, "opt_in must not trigger install");
      assert.equal(optInReceived.length, 1, "onOptInAvailable must be called");
      assert.equal(optInReceived[0].length, 1);
      assert.equal(optInReceived[0][0].id, "dist-opt-001");
      // No status POST because there are no auto_install reports.
      assert.equal(statusBodies.length, 0);
    });

    /**
     * ISS-5123 — the push is a SNAPSHOT of what the org offers, not an
     * increment. The renderer replaces its pending set from it, so an empty
     * payload is how "the last opt-in pack was withdrawn" reaches the banner.
     * Withholding the push on empty (the previous behavior) left a revoked
     * offer on screen and installable until the app restarted.
     */
    test("pushes an EMPTY opt-in snapshot so a withdrawal can clear the banner", async () => {
      const { fetch: fakeFetch } = makeFakeFetch([]);

      const optInReceived: DistributionDto[][] = [];
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: () => Promise.resolve({ started: true }),
        onOptInAvailable: (dists) => {
          optInReceived.push(dists);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(
        optInReceived.length,
        1,
        "an empty assignment list must still publish a snapshot"
      );
      assert.equal(optInReceived[0].length, 0);
    });

    test("pushes an empty snapshot when the only assignment is auto_install", async () => {
      const { fetch: fakeFetch } = makeFakeFetch([makeAutoInstallDist()]);

      const optInReceived: DistributionDto[][] = [];
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: () => Promise.resolve({ started: true }),
        onOptInAvailable: (dists) => {
          optInReceived.push(dists);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      // The opt-in set going from one pack to none must be published too — it is
      // the same revocation, just with other assignments still present.
      assert.equal(optInReceived.length, 1);
      assert.equal(optInReceived[0].length, 0);
    });
  });

  describe("(8b) pre-install revalidation of an offer (ISS-5123)", () => {
    test("resolves when the distribution is still assigned", async () => {
      const optIn = makeOptInDist();
      const { fetch: fakeFetch } = makeFakeFetch([optIn]);
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: () => Promise.resolve({ started: true }),
      });

      await installer.assertDistributionAssigned(COMPUTE_TARGET_ID, optIn.id);
    });

    test("rejects once the offer has been withdrawn", async () => {
      const optIn = makeOptInDist();
      // Withdrawal is expressed to the desktop as absence from the poll.
      const { fetch: fakeFetch } = makeFakeFetch([]);
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: () => Promise.resolve({ started: true }),
      });

      await assert.rejects(
        () => installer.assertDistributionAssigned(COMPUTE_TARGET_ID, optIn.id),
        NO_LONGER_ASSIGNED_ERROR
      );
    });
  });

  describe("(8c) opt-in distributions surfaced, not installed (cont.)", () => {
    test("mixed auto_install + opt_in: installs auto only, surfaces opt_in", async () => {
      const autoInst = makeAutoInstallDist();
      const optIn = makeOptInDist();
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([
        autoInst,
        optIn,
      ]);

      const optInReceived: DistributionDto[] = [];
      const installCalls: string[] = [];

      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: (packId) => {
          installCalls.push(packId);
          return Promise.resolve({ started: true, runId: 1 });
        },
        onOptInAvailable: (dists) => {
          optInReceived.push(...dists);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(installCalls.length, 1);
      assert.equal(installCalls[0], "rtk");
      assert.equal(optInReceived.length, 1);
      assert.equal(optInReceived[0].id, "dist-opt-001");
      assert.equal(statusBodies.length, 1);
      assert.equal(statusBodies[0].reports.length, 1);
      assert.equal(statusBodies[0].reports[0].distributionId, "dist-001");
    });
  });

  describe("(9) re-entrant reconcile guard", () => {
    test("concurrent reconcile() calls do not trigger double-install", async () => {
      const dist = makeAutoInstallDist();

      let resolveInstall!: () => void;
      const installPromise = new Promise<void>((res) => {
        resolveInstall = res;
      });

      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);
      const installCalls: string[] = [];

      // Model a real install: once runInstall lands, the pack is present, so a
      // subsequent getInstalledVersion reports its version. ISS-4428 changed the
      // in-flight guard to coalesce (rather than drop) a request that arrives
      // mid-reconcile, so one trailing pass runs after the first drains — but
      // that pass sees the pack already installed and does NOT re-install.
      let installedVersion: string | null = null;
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => installedVersion,
        runInstall: async (packId) => {
          installCalls.push(packId);
          // Block until the test resolves the promise.
          await installPromise;
          installedVersion = "1.0.0";
          return { started: true, runId: 1 };
        },
      });

      // Fire two concurrent reconcile() calls. The second is coalesced into a
      // single trailing pass (not dropped, not a second concurrent install).
      const p1 = installer.reconcile(COMPUTE_TARGET_ID);
      const p2 = installer.reconcile(COMPUTE_TARGET_ID);

      // Release the blocked install.
      resolveInstall();
      await Promise.all([p1, p2]);

      // Exactly one install: the concurrent second call did not double-install,
      // and the coalesced trailing pass no-ops on the now-installed pack.
      assert.equal(installCalls.length, 1);
      // Two status reports: the install pass, then the idempotent trailing pass
      // (which reports the already-installed version, not a re-install).
      assert.equal(statusBodies.length, 2);
      assert.equal(statusBodies[0].reports[0].status, "installed");
      assert.equal(statusBodies[1].reports[0].status, "installed");
      assert.equal(statusBodies[1].reports[0].installedVersion, "1.0.0");
    });

    test("a request that lands mid-reconcile is coalesced, not dropped (ISS-4428)", async () => {
      // The race the fix closes: a runtime-ready trigger arrives while the
      // cloud-online reconcile is still in flight. The in-flight guard used to
      // drop it, stranding a deferred "runtime not ready" pack until the next
      // cloud-online. Now it runs exactly one trailing pass. Here the runtime is
      // not ready on the first pass (deferred) and ready on the coalesced
      // trailing pass, which installs the pack the first pass deferred.
      const dist = makeAutoInstallDist();

      let resolveFirst!: () => void;
      const firstReconcileGate = new Promise<void>((res) => {
        resolveFirst = res;
      });

      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);
      const installCalls: string[] = [];
      // Runtime readiness is decided by which reconcile pass this is, not by a
      // shared flag whose timing depends on microtask ordering: the first
      // runInstall (the pass we hold open so the second reconcile lands
      // mid-flight) defers; the coalesced trailing pass installs.
      let runInstallCount = 0;

      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: async (packId) => {
          runInstallCount += 1;
          if (runInstallCount === 1) {
            // Hold the first (runtime-not-ready) pass open so the second
            // reconcile lands while it is still in flight, then defer.
            await firstReconcileGate;
            return null;
          }
          installCalls.push(packId);
          return { started: true, runId: 9 };
        },
      });

      const first = installer.reconcile(COMPUTE_TARGET_ID);
      // Second reconcile lands while `first` is blocked → coalesced as pending.
      const second = installer.reconcile(COMPUTE_TARGET_ID);
      // Let the first (deferring) pass finish; the coalesced trailing pass then
      // runs and installs the pack the first pass deferred.
      resolveFirst();
      await Promise.all([first, second]);

      assert.equal(
        installCalls.length,
        1,
        "the coalesced trailing pass installed the deferred pack"
      );
      assert.equal(statusBodies.length, 2);
      assert.equal(statusBodies[0].reports[0].status, "pending");
      assert.equal(statusBodies[1].reports[0].status, "installed");
    });
  });

  describe("normalizePackId behavior (via catalogItem.name mapping)", () => {
    const cases: [string, string][] = [
      ["RTK", "rtk"],
      ["GStack", "gstack"],
      ["Web Command Enablement Pack", "web-command-enablement-pack"],
      ["My Pack 2.0!", "my-pack-2-0"],
      // Leading/trailing separators stripped
      ["  spaces  ", "spaces"],
    ];

    for (const [name, expectedPackId] of cases) {
      test(`normalizes "${name}" → "${expectedPackId}"`, async () => {
        const dist = makeAutoInstallDist({
          catalogItem: {
            id: "ci-n",
            targetKind: "plugin",
            name,
            source: "curated",
          },
        });
        const { fetch: fakeFetch } = makeFakeFetch([dist]);

        let receivedPackId: string | null = null;
        const installer = new RequiredPluginInstaller({
          distributionsClient: makeClientOptions(fakeFetch),
          getInstalledVersion: async () => null,
          runInstall: (packId) => {
            receivedPackId = packId;
            return Promise.resolve({ started: true });
          },
        });

        await installer.reconcile(COMPUTE_TARGET_ID);
        assert.equal(receivedPackId, expectedPackId);
      });
    }

    test("distributions with no catalogItem.name are skipped (no install, no report)", async () => {
      const dist = makeAutoInstallDist({
        catalogItem: {
          id: "ci-noname",
          targetKind: "plugin",
          name: "",
          source: "curated",
        },
      });
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

      const installCalls: string[] = [];
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: (packId) => {
          installCalls.push(packId);
          return Promise.resolve({ started: true });
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(installCalls.length, 0, "empty name → no install");
      // No reports to POST → no status call.
      assert.equal(statusBodies.length, 0);
    });
  });

  describe("runtime-not-ready (runInstall returns null)", () => {
    test("reports pending when runInstall returns null (runtime not ready)", async () => {
      const dist = makeAutoInstallDist();
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);

      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: async () => null,
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(statusBodies.length, 1);
      const report = statusBodies[0].reports[0];
      assert.equal(report.distributionId, "dist-001");
      assert.equal(report.status, "pending");
      assert.ok(report.failureReason?.includes("runtime not ready"));
    });
  });

  // FEA-4050: a declined opt-in pack must not be re-surfaced by reconcile.
  describe("(10) declined opt-in packs are suppressed (FEA-4050)", () => {
    test("declined distribution is NOT passed to onOptInAvailable", async () => {
      const optIn = makeOptInDist();
      const { fetch: fakeFetch } = makeFakeFetch([optIn]);

      const optInReceived: DistributionDto[] = [];
      const declinedIds = new Set([optIn.id]);
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: async () => ({ started: true }),
        isDistributionDeclined: (id, _computeTargetId) => declinedIds.has(id),
        onOptInAvailable: (dists) => {
          optInReceived.push(...dists);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(
        optInReceived.length,
        0,
        "a declined opt-in pack must not be re-surfaced"
      );
    });

    test("a genuinely-new offer (different id) IS still surfaced", async () => {
      // The user declined dist-opt-001; the admin re-shares as a NEW assignment
      // dist-opt-002. The new id must NOT be suppressed by the old decline.
      const newOffer = makeOptInDist({ id: "dist-opt-002" });
      const { fetch: fakeFetch } = makeFakeFetch([newOffer]);

      const optInReceived: DistributionDto[] = [];
      const declinedIds = new Set(["dist-opt-001"]);
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: async () => ({ started: true }),
        isDistributionDeclined: (id, _computeTargetId) => declinedIds.has(id),
        onOptInAvailable: (dists) => {
          optInReceived.push(...dists);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(optInReceived.length, 1, "a new offer must be surfaced");
      assert.equal(optInReceived[0].id, "dist-opt-002");
    });

    test("mixed: only the declined pack is filtered, others pass through", async () => {
      const declined = makeOptInDist({ id: "dist-opt-001" });
      const fresh = makeOptInDist({
        id: "dist-opt-003",
        catalogItemId: "ci-opt-003",
        catalogItem: {
          id: "ci-opt-003",
          targetKind: "skill",
          name: "Verify",
          source: "curated",
        },
      });
      const { fetch: fakeFetch } = makeFakeFetch([declined, fresh]);

      const optInReceived: DistributionDto[] = [];
      const declinedIds = new Set(["dist-opt-001"]);
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: async () => ({ started: true }),
        isDistributionDeclined: (id, _computeTargetId) => declinedIds.has(id),
        onOptInAvailable: (dists) => {
          optInReceived.push(...dists);
        },
      });

      await installer.reconcile(COMPUTE_TARGET_ID);

      assert.equal(optInReceived.length, 1);
      assert.equal(optInReceived[0].id, "dist-opt-003");
    });
  });

  // FEA-4050: declineDistributionById records the cloud-authoritative identity.
  describe("(11) declineDistributionById persists identity (FEA-4050)", () => {
    test("persists id-first, then enriches with the resolved cloud identity", async () => {
      const optIn = makeOptInDist();
      const { fetch: fakeFetch } = makeFakeFetch([optIn]);

      const recorded: Array<{
        distributionId: string;
        catalogItemId: string;
        organizationId: string;
        computeTargetId: string;
      }> = [];
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: async () => ({ started: true }),
        recordDeclinedDistribution: (record) => {
          recorded.push(record);
        },
      });

      await installer.declineDistributionById(COMPUTE_TARGET_ID, optIn.id);

      // Durability: the id is persisted BEFORE the cloud lookup (write #1,
      // id-only) so a quit mid-lookup cannot lose the decline; the second write
      // enriches the audit fields from the authoritative cloud response.
      assert.equal(recorded.length, 2, "id-first then enriched");
      assert.equal(recorded[0].distributionId, optIn.id);
      assert.equal(recorded[0].catalogItemId, "", "write #1 is id-only");
      assert.equal(recorded[0].organizationId, "");
      assert.equal(
        recorded[0].computeTargetId,
        COMPUTE_TARGET_ID,
        "id-first write is compute-target scoped"
      );
      assert.equal(recorded[1].distributionId, optIn.id);
      // Identity comes from the authoritative cloud response, not renderer data.
      assert.equal(recorded[1].catalogItemId, optIn.catalogItemId);
      assert.equal(recorded[1].organizationId, optIn.organizationId);
      assert.equal(recorded[1].computeTargetId, COMPUTE_TARGET_ID);
    });

    test("keeps only the id-first record when the distribution is no longer assigned", async () => {
      // The offer was withdrawn cloud-side; the decline must still persist so a
      // re-appearance under the same id stays suppressed. Suppression keys on
      // distributionId alone, so empty audit fields are acceptable. Only the
      // id-first write happens — the enrich returns early on not-found.
      const { fetch: fakeFetch } = makeFakeFetch([]);

      const recorded: Array<{
        distributionId: string;
        computeTargetId: string;
      }> = [];
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: async () => ({ started: true }),
        recordDeclinedDistribution: (record) => {
          recorded.push(record);
        },
      });

      await installer.declineDistributionById(
        COMPUTE_TARGET_ID,
        "dist-gone-001"
      );

      assert.equal(recorded.length, 1, "only the durable id-first write");
      assert.equal(recorded[0].distributionId, "dist-gone-001");
      assert.equal(recorded[0].computeTargetId, COMPUTE_TARGET_ID);
    });

    test("keeps the id-first decline durable when the cloud re-fetch throws", async () => {
      // Offline / transient failure during the enrich step must not lose the
      // decline: the id-first write already persisted it durably.
      const throwingFetch = (() =>
        Promise.reject(new Error("network down"))) as typeof fetch;

      const recorded: Array<{
        distributionId: string;
        catalogItemId: string;
        computeTargetId: string;
      }> = [];
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(throwingFetch),
        getInstalledVersion: async () => null,
        runInstall: async () => ({ started: true }),
        recordDeclinedDistribution: (record) => {
          recorded.push(record);
        },
      });

      await installer.declineDistributionById(
        COMPUTE_TARGET_ID,
        "dist-off-001"
      );

      assert.equal(recorded.length, 1, "id-first write survives the throw");
      assert.equal(recorded[0].distributionId, "dist-off-001");
      assert.equal(recorded[0].catalogItemId, "");
      assert.equal(recorded[0].computeTargetId, COMPUTE_TARGET_ID);
    });
  });
});
