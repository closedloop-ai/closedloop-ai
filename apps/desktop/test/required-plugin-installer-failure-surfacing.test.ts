/**
 * @file required-plugin-installer-failure-surfacing.test.ts
 * @description ISS-5027 regression coverage for the distribution install path.
 *
 * Two distribution installs failed back to back in production and neither was
 * legible: both were `gatewayLog.warn`, indistinguishable from routine deferral
 * noise, so nobody noticed that an admin's pushed pack never reached the team.
 *
 * Covers:
 *   (1) The installer asks for the `"auto"` sentinel via the shared constant,
 *       which `streamRun` now resolves for EVERY pack class (not just
 *       `single_install`).
 *   (2) A genuine not-started install surfaces at ERROR level naming both the
 *       distribution and the pack, and reports `failed` to the cloud.
 *   (3) The version-skew case (`ENOTFOUND` — cloud distributed a pack this
 *       desktop build's compiled-in catalog seed does not contain) degrades
 *       gracefully: the reconcile keeps going and later distributions still
 *       install, but the failure reason says what actually happened rather
 *       than the bare orchestrator text.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CatalogItemSource } from "@repo/api/src/types/distribution";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { RequiredPluginInstaller } from "../src/main/packs/required-plugin-installer.js";
import {
  HARNESS_AUTO,
  StreamRunErrorCode,
  type StreamRunResult,
} from "../src/shared/install-run-contract.js";
import {
  COMPUTE_TARGET_ID,
  makeAutoInstallDist,
  makeClientOptions,
  makeFakeFetch,
} from "./support/required-plugin-installer-fixtures.js";

const DIST_ID_RE = /dist-001/;
const INSTALL_FAILED_RE = /install of 'rtk' FAILED/;
const VERSION_SKEW_RE = /not in this desktop build's catalog/;
const RETRYABLE_RE = /could not start yet \(retryable\)/;

type CapturedLog = { level: "error" | "warn"; message: string };

/**
 * Capture what the installer routes to the gateway log. The log level is the
 * monitored signal this ticket changed, so it is the contract under test — not
 * incidental debug chatter.
 */
function captureGatewayLog(): {
  entries: CapturedLog[];
  restore: () => void;
} {
  const entries: CapturedLog[] = [];
  gatewayLog.error = (_tag: string, message: string) => {
    entries.push({ level: "error", message });
  };
  gatewayLog.warn = (_tag: string, message: string) => {
    entries.push({ level: "warn", message });
  };
  return {
    entries,
    // Delete the own properties rather than assigning copies back, so the
    // shared singleton is left exactly as it was found (its prototype methods).
    restore: () => {
      Reflect.deleteProperty(gatewayLog, "error");
      Reflect.deleteProperty(gatewayLog, "warn");
    },
  };
}

describe("RequiredPluginInstaller — ISS-5027 install failure surfacing", () => {
  test("asks streamRun to resolve the harness, sending the auto sentinel", async () => {
    const { fetch: fakeFetch } = makeFakeFetch([makeAutoInstallDist()]);
    const harnesses: string[] = [];

    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      runInstall: (_packId, harness) => {
        harnesses.push(harness);
        return Promise.resolve({
          runId: 1,
          started: true,
        } satisfies StreamRunResult);
      },
    });

    await installer.reconcile(COMPUTE_TARGET_ID);

    assert.deepEqual(harnesses, [HARNESS_AUTO]);
  });

  test("a PERMANENTLY failed install is logged at ERROR naming the distribution and pack", async () => {
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([
      makeAutoInstallDist(),
    ]);
    const captured = captureGatewayLog();

    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      runInstall: () =>
        Promise.resolve({
          error: {
            code: StreamRunErrorCode.NoCommand,
            message: "pack 'rtk' has no install command for any harness.",
          },
          started: false,
        } satisfies StreamRunResult),
    });

    try {
      await installer.reconcile(COMPUTE_TARGET_ID);
    } finally {
      captured.restore();
    }

    const failures = captured.entries.filter(
      (entry) => entry.level === "error"
    );
    assert.equal(failures.length, 1, "a failed install must raise one error");
    assert.match(failures[0].message, DIST_ID_RE);
    assert.match(failures[0].message, INSTALL_FAILED_RE);
    assert.equal(
      captured.entries.some((entry) => entry.level === "warn"),
      false,
      "a real failure must not be downgraded to a warning"
    );

    assert.equal(statusBodies[0].reports[0].status, "failed");
  });

  test("a RETRYABLE not-started install stays at warn", async () => {
    // `reconcile()` fires on every cloud-online transition and on runtime-ready.
    // A user who simply has not installed the CLI yet must not generate a fresh
    // error on every reconnect — that recreates the noise this ticket removed.
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([
      makeAutoInstallDist(),
    ]);
    const captured = captureGatewayLog();

    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      runInstall: () =>
        Promise.resolve({
          error: {
            code: StreamRunErrorCode.NoCli,
            message:
              "pack 'rtk' supports (claude) but none of those CLIs are on PATH.",
          },
          started: false,
        } satisfies StreamRunResult),
    });

    try {
      await installer.reconcile(COMPUTE_TARGET_ID);
    } finally {
      captured.restore();
    }

    assert.deepEqual(
      captured.entries.map((entry) => entry.level),
      ["warn"]
    );
    assert.match(captured.entries[0].message, RETRYABLE_RE);
    // The cloud is still told the device did not converge.
    assert.equal(statusBodies[0].reports[0].status, "failed");
  });

  test("an unknown pack id reports version skew and does not block later distributions", async () => {
    const unknown = makeAutoInstallDist({
      catalogItem: {
        id: "ci-sweep",
        name: "cl-sweep",
        source: CatalogItemSource.Curated,
        targetKind: "plugin",
      },
      catalogItemId: "ci-sweep",
      id: "dist-unknown",
    });
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([
      unknown,
      makeAutoInstallDist(),
    ]);
    const captured = captureGatewayLog();

    const installedPacks: string[] = [];
    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      runInstall: (packId) => {
        if (packId === "cl-sweep") {
          return Promise.resolve({
            error: {
              code: StreamRunErrorCode.NotFound,
              message: "pack_id not in catalog: cl-sweep",
            },
            started: false,
          } satisfies StreamRunResult);
        }
        installedPacks.push(packId);
        return Promise.resolve({
          runId: 5,
          started: true,
        } satisfies StreamRunResult);
      },
    });

    try {
      await installer.reconcile(COMPUTE_TARGET_ID);
    } finally {
      captured.restore();
    }

    const reports = statusBodies[0].reports;
    const skewed = reports.find(
      (report) => report.distributionId === "dist-unknown"
    );
    assert.equal(skewed?.status, "failed");
    assert.match(String(skewed?.failureReason), VERSION_SKEW_RE);
    // Graceful degradation: the peer-version gap must not stop the sweep.
    assert.deepEqual(installedPacks, ["rtk"]);
    assert.equal(
      reports.find((report) => report.distributionId === "dist-001")?.status,
      "installed"
    );
  });
});
