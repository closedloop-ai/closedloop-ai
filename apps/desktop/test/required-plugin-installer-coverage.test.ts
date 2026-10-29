/**
 * @file required-plugin-installer-coverage.test.ts
 * @description ISS-10514 branch coverage for RequiredPluginInstaller paths the
 * sibling suites do not drive: the renderer-initiated coaching accept path
 * (including its "unavailable before any cloud lookup" ordering), the decline
 * sink-absent and non-Error re-fetch paths, the runtime-ready rejection log,
 * the coaching auto-install outcomes, and the non-Error / no-error-object
 * install results. Network is never touched: the shared fake fetch serves the
 * two distributions endpoints.
 */

import {
  CatalogItemSource,
  type DistributionDto,
  DistributionMode,
  type DistributionStatusReport,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { afterEach, describe, expect, test, vi } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  type CoachingInstallOutcome,
  RequiredPluginInstaller,
} from "../src/main/packs/required-plugin-installer.js";
import {
  ACCESS_TOKEN,
  API_ORIGIN,
  COMPUTE_TARGET_ID,
  deferred,
  makeAutoInstallDist,
  makeClientOptions,
  makeFakeFetch,
  makeOptInDist,
} from "./support/required-plugin-installer-fixtures.js";

const INSTALLER_TAG = "required-plugin-installer";
const NOT_AVAILABLE_ERROR = /^Coaching install is not available yet\.$/;
const NO_LONGER_ASSIGNED_ERROR = /^Distribution is no longer assigned\.$/;
const NOT_COACHING_ERROR = /^Distribution is not a coaching pack\.$/;
const DEFAULT_FAILED_ERROR = /^Coaching install failed\.$/;
const DISABLED_ERROR = /^Coaching Packs is disabled\.$/;
const CUSTOM_FAILED_ERROR = /^zip checksum mismatch$/;

function makeCoachingDist(
  overrides: Partial<DistributionDto> = {}
): DistributionDto {
  return makeAutoInstallDist({
    id: "dist-coach-001",
    catalogItemId: "ci-coach-001",
    catalogItem: {
      id: "ci-coach-001",
      targetKind: "plugin",
      name: "Coach",
      source: CatalogItemSource.Curated,
      coaching: true,
    },
    ...overrides,
  });
}

/**
 * Client options whose token read and fetch are both spies, so a test can
 * prove no cloud lookup started.
 */
function makeSpiedClient(assigned: DistributionDto[]) {
  const fake = makeFakeFetch(assigned);
  const fetchSpy = vi.fn(fake.fetch);
  const getAccessToken = vi.fn(async () => ACCESS_TOKEN);
  return {
    client: {
      getAccessToken,
      getApiOrigin: () => API_ORIGIN,
      fetch: fetchSpy,
    },
    fetchSpy,
    getAccessToken,
    statusBodies: fake.statusBodies,
  };
}

/** Reconciles once and returns the report list of every status POST. */
async function reconcileReports(
  installer: RequiredPluginInstaller,
  statusBodies: Array<{ reports: DistributionStatusReport[] }>
): Promise<DistributionStatusReport[][]> {
  await installer.reconcile(COMPUTE_TARGET_ID);
  return statusBodies.map((body) => body.reports);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("installCoachingDistributionById", () => {
  test("rejects as unavailable before any token read or distributions lookup", async () => {
    const dist = makeCoachingDist();
    const { client, fetchSpy, getAccessToken } = makeSpiedClient([dist]);
    const installer = new RequiredPluginInstaller({
      distributionsClient: client,
      getInstalledVersion: async () => null,
      runInstall: async () => null,
    });

    await expect(
      installer.installCoachingDistributionById(COMPUTE_TARGET_ID, dist.id)
    ).rejects.toThrow(NOT_AVAILABLE_ERROR);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects without installing when the distribution is no longer assigned", async () => {
    const { client, fetchSpy } = makeSpiedClient([makeCoachingDist()]);
    const install = vi.fn(
      async (): Promise<CoachingInstallOutcome> => ({ status: "installed" })
    );
    const installer = new RequiredPluginInstaller({
      distributionsClient: client,
      getInstalledVersion: async () => null,
      runInstall: async () => null,
      installCoachingDistribution: install,
    });

    await expect(
      installer.installCoachingDistributionById(COMPUTE_TARGET_ID, "dist-gone")
    ).rejects.toThrow(NO_LONGER_ASSIGNED_ERROR);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
  });

  test("rejects without installing when the assigned distribution is not a coaching pack", async () => {
    const plain = makeAutoInstallDist();
    const { client } = makeSpiedClient([plain]);
    const install = vi.fn(
      async (): Promise<CoachingInstallOutcome> => ({ status: "installed" })
    );
    const installer = new RequiredPluginInstaller({
      distributionsClient: client,
      getInstalledVersion: async () => null,
      runInstall: async () => null,
      installCoachingDistribution: install,
    });

    await expect(
      installer.installCoachingDistributionById(COMPUTE_TARGET_ID, plain.id)
    ).rejects.toThrow(NOT_COACHING_ERROR);
    expect(install).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "a failed outcome with a reason rejects with that reason",
      outcome: {
        status: "failed",
        failureReason: "zip checksum mismatch",
      } satisfies CoachingInstallOutcome,
      error: CUSTOM_FAILED_ERROR,
    },
    {
      name: "a failed outcome without a reason rejects with the default message",
      outcome: { status: "failed" } satisfies CoachingInstallOutcome,
      error: DEFAULT_FAILED_ERROR,
    },
    {
      name: "a disabled outcome rejects as disabled",
      outcome: { status: "disabled" } satisfies CoachingInstallOutcome,
      error: DISABLED_ERROR,
    },
  ])("$name", async ({ outcome, error }) => {
    const dist = makeCoachingDist();
    const { client } = makeSpiedClient([dist]);
    const installer = new RequiredPluginInstaller({
      distributionsClient: client,
      getInstalledVersion: async () => null,
      runInstall: async () => null,
      installCoachingDistribution: async () => outcome,
    });

    await expect(
      installer.installCoachingDistributionById(COMPUTE_TARGET_ID, dist.id)
    ).rejects.toThrow(error);
  });

  test("returns a skipped outcome and installs the cloud-resolved distribution", async () => {
    const dist = makeCoachingDist({ mode: DistributionMode.OptIn });
    const remaining = makeOptInDist({ id: "dist-coach-remaining" });
    const { client } = makeSpiedClient([dist, remaining]);
    const outcome: CoachingInstallOutcome = { status: "skipped" };
    const install = vi.fn(async (_dist: DistributionDto) => outcome);
    const clearOptInSnapshot = vi.fn();
    const onOptInAvailable = vi.fn();
    const installer = new RequiredPluginInstaller({
      distributionsClient: client,
      getInstalledVersion: async () => null,
      runInstall: async () => null,
      installCoachingDistribution: install,
      clearOptInSnapshot,
      onOptInAvailable,
    });

    await expect(
      installer.installCoachingDistributionById(COMPUTE_TARGET_ID, dist.id)
    ).resolves.toEqual(outcome);
    expect(install).toHaveBeenCalledTimes(1);
    const [installed] = install.mock.calls[0];
    expect(installed.id).toBe(dist.id);
    expect(installed.assetDownloadUrl).toBe(dist.assetDownloadUrl);
    expect(clearOptInSnapshot).toHaveBeenCalledTimes(1);
    expect(
      onOptInAvailable.mock.calls[0]?.[0].map(
        (distribution: DistributionDto) => distribution.id
      )
    ).toEqual([remaining.id]);
  });
});

describe("acknowledgeOptInHandled", () => {
  test("clears the stale snapshot and republishes only the remaining offers", async () => {
    const handled = makeOptInDist({ id: "dist-handled" });
    const remaining = makeOptInDist({ id: "dist-remaining" });
    const { client } = makeSpiedClient([handled, remaining]);
    const clearOptInSnapshot = vi.fn();
    const onOptInAvailable = vi.fn();
    const installer = new RequiredPluginInstaller({
      distributionsClient: client,
      getInstalledVersion: async () => null,
      runInstall: async () => null,
      clearOptInSnapshot,
      onOptInAvailable,
    });

    await installer.acknowledgeOptInHandled(COMPUTE_TARGET_ID, handled.id);

    expect(clearOptInSnapshot).toHaveBeenCalledTimes(1);
    expect(
      onOptInAvailable.mock.calls[0]?.[0].map(
        (distribution: DistributionDto) => distribution.id
      )
    ).toEqual([remaining.id]);
  });

  test("clears the stale snapshot without a cloud target", async () => {
    const { client, fetchSpy, getAccessToken } = makeSpiedClient([]);
    const clearOptInSnapshot = vi.fn();
    const installer = new RequiredPluginInstaller({
      distributionsClient: client,
      getInstalledVersion: async () => null,
      runInstall: async () => null,
      clearOptInSnapshot,
    });

    await installer.acknowledgeOptInHandled(null, "dist-handled");

    expect(clearOptInSnapshot).toHaveBeenCalledTimes(1);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("declineDistributionById", () => {
  test("is a no-op with no decline sink: no cloud lookup starts", async () => {
    const { client, fetchSpy, getAccessToken } = makeSpiedClient([
      makeAutoInstallDist(),
    ]);
    const installer = new RequiredPluginInstaller({
      distributionsClient: client,
      getInstalledVersion: async () => null,
      runInstall: async () => null,
    });

    await expect(
      installer.declineDistributionById(COMPUTE_TARGET_ID, "dist-001")
    ).resolves.toBeUndefined();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("clears the stale snapshot and republishes the remaining offers", async () => {
    const declined = makeOptInDist({ id: "dist-declined" });
    const remaining = makeOptInDist({ id: "dist-remaining" });
    const { client } = makeSpiedClient([declined, remaining]);
    const events: string[] = [];
    const installer = new RequiredPluginInstaller({
      distributionsClient: client,
      getInstalledVersion: async () => null,
      runInstall: async () => null,
      clearOptInSnapshot: () => events.push("clear"),
      onOptInAvailable: (distributions) =>
        events.push(`publish:${distributions.map(({ id }) => id).join(",")}`),
      recordDeclinedDistribution: () => undefined,
    });

    await installer.declineDistributionById(COMPUTE_TARGET_ID, declined.id);

    expect(events).toEqual(["clear", `publish:${remaining.id}`]);
  });

  test.each([
    {
      name: "an Error",
      thrown: new Error("origin exploded"),
      text: "origin exploded",
    },
    {
      name: "a non-Error value",
      thrown: "origin string",
      text: "origin string",
    },
  ])(
    "keeps the id-only record and logs the message when the re-fetch throws $name",
    async ({ thrown, text }) => {
      const warn = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
        /* captured */
      });
      const records: Array<{
        distributionId: string;
        catalogItemId: string;
        organizationId: string;
        computeTargetId: string;
      }> = [];
      const failure: unknown = thrown;
      const installer = new RequiredPluginInstaller({
        distributionsClient: {
          getAccessToken: async () => ACCESS_TOKEN,
          getApiOrigin: () => {
            throw failure;
          },
        },
        getInstalledVersion: async () => null,
        runInstall: async () => null,
        recordDeclinedDistribution: (record) => {
          records.push(record);
        },
      });

      await installer.declineDistributionById(COMPUTE_TARGET_ID, "dist-001");

      expect(records).toEqual([
        {
          distributionId: "dist-001",
          catalogItemId: "",
          organizationId: "",
          computeTargetId: COMPUTE_TARGET_ID,
        },
      ]);
      expect(warn).toHaveBeenCalledWith(
        INSTALLER_TAG,
        `distribution dist-001: decline audit re-resolve failed, keeping id-only record: ${text}`
      );
    }
  );
});

describe("notifyRuntimeReady rejection logging", () => {
  test.each([
    {
      name: "an Error",
      thrown: new Error("store bounced"),
      text: "store bounced",
    },
    { name: "a non-Error value", thrown: "raw failure", text: "raw failure" },
  ])(
    "logs the reconcile rejection message when it rejects with $name",
    async ({ thrown, text }) => {
      const logged = deferred<string>();
      vi.spyOn(gatewayLog, "warn").mockImplementation((tag, message) => {
        if (tag === INSTALLER_TAG) {
          logged.resolve(message);
        }
      });
      const { fetch: fakeFetch } = makeFakeFetch([makeAutoInstallDist()]);
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: () => Promise.reject(thrown),
        runInstall: async () => null,
        resolveRuntimeReadyTarget: () => COMPUTE_TARGET_ID,
      });

      installer.notifyRuntimeReady();

      await expect(logged.promise).resolves.toBe(
        `runtime-ready reconcile failed (best-effort, will retry on next cloud online): ${text}`
      );
    }
  );
});

describe("coaching auto-install via reconcile", () => {
  test.each([
    {
      name: "an Error",
      thrown: new Error("download 403"),
      text: "download 403",
    },
    {
      name: "a non-Error value",
      thrown: "extract blew up",
      text: "extract blew up",
    },
  ])(
    "reports failed with the thrown message when the install throws $name",
    async ({ thrown, text }) => {
      const warn = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
        /* captured */
      });
      const dist = makeCoachingDist();
      const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);
      const runInstall = vi.fn(async () => null);
      const installer = new RequiredPluginInstaller({
        distributionsClient: makeClientOptions(fakeFetch),
        getInstalledVersion: async () => null,
        runInstall,
        installCoachingDistribution: () => Promise.reject(thrown),
      });

      const reports = await reconcileReports(installer, statusBodies);

      expect(reports).toEqual([
        [
          {
            distributionId: dist.id,
            status: DistributionTargetStatusValue.Failed,
            failureReason: text,
          },
        ],
      ]);
      expect(runInstall).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        INSTALLER_TAG,
        `distribution ${dist.id}: coaching install threw: ${text}`
      );
    }
  );

  test.each([
    {
      name: "with its own reason",
      outcome: {
        status: "failed",
        failureReason: "bad manifest",
      } satisfies CoachingInstallOutcome,
      reason: "bad manifest",
    },
    {
      name: "without a reason, using the default",
      outcome: { status: "failed" } satisfies CoachingInstallOutcome,
      reason: "coaching install failed",
    },
  ])("reports a failed outcome $name", async ({ outcome, reason }) => {
    const dist = makeCoachingDist();
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);
    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: async () => null,
      runInstall: async () => null,
      installCoachingDistribution: async () => outcome,
    });

    const reports = await reconcileReports(installer, statusBodies);

    expect(reports).toEqual([
      [
        {
          distributionId: dist.id,
          status: DistributionTargetStatusValue.Failed,
          failureReason: reason,
        },
      ],
    ]);
  });

  test("reports installed with no installedVersion when the outcome carries none", async () => {
    const dist = makeCoachingDist();
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);
    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: async () => null,
      runInstall: async () => null,
      installCoachingDistribution: async () => ({ status: "installed" }),
    });

    const reports = await reconcileReports(installer, statusBodies);

    expect(reports).toEqual([
      [
        {
          distributionId: dist.id,
          status: DistributionTargetStatusValue.Installed,
        },
      ],
    ]);
  });
});

describe("coaching auto-install version reporting", () => {
  test("reports installed with the outcome's installedVersion for a skipped install", async () => {
    const dist = makeCoachingDist();
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);
    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: async () => null,
      runInstall: async () => null,
      installCoachingDistribution: async () => ({
        status: "skipped",
        installedVersion: "2.0.0",
      }),
    });

    const reports = await reconcileReports(installer, statusBodies);

    expect(reports).toEqual([
      [
        {
          distributionId: dist.id,
          status: DistributionTargetStatusValue.Installed,
          installedVersion: "2.0.0",
        },
      ],
    ]);
  });
});

describe("generic auto-install result edges", () => {
  test("reports failed with the stringified value when runInstall throws a non-Error", async () => {
    const error = vi.spyOn(gatewayLog, "error").mockImplementation(() => {
      /* captured */
    });
    const dist = makeAutoInstallDist();
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);
    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: async () => null,
      runInstall: () => Promise.reject("spawn refused"),
    });

    const reports = await reconcileReports(installer, statusBodies);

    expect(reports).toEqual([
      [
        {
          distributionId: dist.id,
          status: DistributionTargetStatusValue.Failed,
          failureReason: "spawn refused",
        },
      ],
    ]);
    expect(error).toHaveBeenCalledWith(
      INSTALLER_TAG,
      "distribution dist-001: install of 'rtk' FAILED — runInstall threw: spawn refused"
    );
  });

  test("a not-started result with no error object reports the default reason and stays retryable", async () => {
    const warn = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      /* captured */
    });
    const error = vi.spyOn(gatewayLog, "error").mockImplementation(() => {
      /* captured */
    });
    const dist = makeAutoInstallDist();
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([dist]);
    const onTerminalInstallFailure = vi.fn();
    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: async () => null,
      runInstall: async () => ({ started: false }),
      onTerminalInstallFailure,
    });
    installer.notifyRuntimeReady();

    const reports = await reconcileReports(installer, statusBodies);

    expect(reports).toEqual([
      [
        {
          distributionId: dist.id,
          status: DistributionTargetStatusValue.Failed,
          failureReason: "install did not start",
        },
      ],
    ]);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      INSTALLER_TAG,
      "distribution dist-001: install of 'rtk' could not start yet (retryable) — install did not start"
    );
    expect(onTerminalInstallFailure).not.toHaveBeenCalled();
  });
});
