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
import type {
  DistributionDto,
  DistributionStatusReport,
} from "@repo/api/src/types/distribution";
import type { StreamRunResult } from "../src/main/packs/install-orchestrator.js";
import { RequiredPluginInstaller } from "../src/main/packs/required-plugin-installer.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const COMPUTE_TARGET_ID = "ct-test-001";
const API_ORIGIN = "https://api.example.com";
const ACCESS_TOKEN = "test-access-token";

type StatusBody = {
  computeTargetId: string;
  reports: DistributionStatusReport[];
};

/**
 * Builds a DistributionDto for use in tests.
 * The assetDownloadUrl is set to a non-null value to verify the trust boundary —
 * the installer must NOT pass it to runInstall or execute it as a command.
 */
function makeAutoInstallDist(
  overrides: Partial<DistributionDto> = {}
): DistributionDto {
  return {
    id: "dist-001",
    organizationId: "org-001",
    catalogItemId: "ci-001",
    catalogItem: {
      id: "ci-001",
      targetKind: "plugin",
      name: "RTK",
      source: "curated",
    },
    mode: "auto_install",
    targetingType: "all",
    desiredEnabled: true,
    targetingEntries: [],
    targetStatuses: [],
    // Explicitly set a presigned S3 URL — the installer MUST NOT execute this.
    assetDownloadUrl:
      "https://s3.example.com/presigned/rtk.zip?token=secret123",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeOptInDist(
  overrides: Partial<DistributionDto> = {}
): DistributionDto {
  return {
    id: "dist-opt-001",
    organizationId: "org-001",
    catalogItemId: "ci-opt-001",
    catalogItem: {
      id: "ci-opt-001",
      targetKind: "plugin",
      name: "GStack",
      source: "curated",
    },
    mode: "opt_in",
    targetingType: "all",
    desiredEnabled: true,
    targetingEntries: [],
    targetStatuses: [],
    assetDownloadUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Creates a fake fetch function that responds to the two distributions endpoints.
 * Records all status POST bodies for later assertion.
 */
function makeFakeFetch(assignedDistributions: DistributionDto[]): {
  fetch: typeof fetch;
  statusBodies: StatusBody[];
} {
  const statusBodies: StatusBody[] = [];

  const fakeFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/desktop/distributions/assigned")) {
      // Wrap in the API envelope format that unwrapApiEnvelope expects:
      // { success: true, data: [...] }
      const body = JSON.stringify({
        success: true,
        data: assignedDistributions,
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/desktop/distributions/status")) {
      const body = await new Request(url, init).json();
      statusBodies.push(body as StatusBody);
      return new Response(
        JSON.stringify({
          success: true,
          data: { accepted: body.reports.length },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    throw new Error(`Unexpected fetch to: ${url}`);
  };

  return { fetch: fakeFetch as unknown as typeof fetch, statusBodies };
}

/**
 * Builds the minimal DistributionsClientOptions for tests.
 */
function makeClientOptions(fetchFn: typeof fetch, authenticated = true) {
  return {
    getAccessToken: async () => (authenticated ? ACCESS_TOKEN : null),
    getApiOrigin: () => (authenticated ? API_ORIGIN : undefined),
    fetch: fetchFn,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    test("concurrent reconcile() calls do not trigger double-install (in-flight guard)", async () => {
      const dist = makeAutoInstallDist();

      let resolveInstall!: () => void;
      const installPromise = new Promise<void>((res) => {
        resolveInstall = res;
      });

      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);
      const installCalls: string[] = [];

      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall: async (packId) => {
          installCalls.push(packId);
          // Block until the test resolves the promise.
          await installPromise;
          return { started: true, runId: 1 };
        },
      });

      // Fire two concurrent reconcile() calls.
      const p1 = installer.reconcile(COMPUTE_TARGET_ID);
      const p2 = installer.reconcile(COMPUTE_TARGET_ID);

      // Release the blocked install.
      resolveInstall();
      await Promise.all([p1, p2]);

      // Only one install should have been triggered (the second reconcile was
      // a no-op due to the in-flight guard).
      assert.equal(installCalls.length, 1);
      assert.equal(statusBodies.length, 1);
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
});
