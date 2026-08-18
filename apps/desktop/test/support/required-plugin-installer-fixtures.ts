/**
 * @file required-plugin-installer-fixtures.ts
 * @description Shared test fixtures for the RequiredPluginInstaller test suites
 * (required-plugin-installer.test.ts and
 * required-plugin-installer-runtime-ready.test.ts). Extracted so both files
 * drive the installer through the SAME injected fake fetch + client options
 * instead of re-declaring the harness (AGENTS.md: extract a shared test fixture
 * when the same nontrivial fixture appears in multiple files). Network is never
 * touched — the fake fetch intercepts the two distributions endpoints.
 */

import {
  CatalogItemSource,
  type DistributionDto,
  DistributionMode,
  type DistributionStatusReport,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";

export const COMPUTE_TARGET_ID = "ct-test-001";
export const API_ORIGIN = "https://api.example.com";
export const ACCESS_TOKEN = "test-access-token";

export type StatusBody = {
  computeTargetId: string;
  reports: DistributionStatusReport[];
};

/**
 * Builds a DistributionDto for use in tests. The assetDownloadUrl is set to a
 * non-null value so the trust-boundary tests can verify the installer never
 * passes it to runInstall or executes it as a command.
 */
export function makeAutoInstallDist(
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
      source: CatalogItemSource.Curated,
    },
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
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

export function makeOptInDist(
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
      source: CatalogItemSource.Curated,
    },
    mode: DistributionMode.OptIn,
    targetingType: DistributionTargetingType.All,
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
 * Options for {@link makeFakeFetch}.
 */
export type FakeFetchOptions = {
  /**
   * Invoked (with the number of status POSTs seen so far, including this one)
   * every time a status POST lands. Lets a test synchronize on the real
   * completion signal emitted by the fire-and-forget runtime-ready path
   * (`notifyRuntimeReady`) instead of polling — resolve a `deferred()` here when
   * the expected POST count is reached.
   */
  onStatusPosted?: (count: number) => void;
};

/**
 * Creates a fake fetch function that responds to the two distributions
 * endpoints. Records all status POST bodies for later assertion.
 */
export function makeFakeFetch(
  assignedDistributions: DistributionDto[],
  options: FakeFetchOptions = {}
): {
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
      options.onStatusPosted?.(statusBodies.length);
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
export function makeClientOptions(fetchFn: typeof fetch, authenticated = true) {
  return {
    getAccessToken: async () => (authenticated ? ACCESS_TOKEN : null),
    getApiOrigin: () => (authenticated ? API_ORIGIN : undefined),
    fetch: fetchFn,
  };
}

/**
 * A minimal externally-resolvable promise. Used to synchronize a test on the
 * real completion signal of a fire-and-forget path (per the desktop test:node
 * determinism rule: resolve on a real signal, never a poll loop).
 */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
