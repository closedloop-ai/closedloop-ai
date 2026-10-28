import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("../service", () => ({
  githubRepoSyncStateBootstrapService: { run: mocks.run },
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@repo/observability/error", () => ({
  parseError: (e: unknown) => e,
}));

import { GET } from "../route";
import type { BootstrapSummary } from "../service";

const CRON_SECRET = "test-cron-secret";

function authorizedRequest(): Request {
  return new Request("https://api.test/cron/bootstrap-repo-sync-states", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

const SUMMARY: BootstrapSummary = {
  orgsSelected: 9,
  orgsBootstrapped: 2,
  orgsPartial: 1,
  orgsFailed: 6,
  reposMaterialized: 42,
  reposFailed: 5,
  stoppedOnDeadline: false,
  observedRepositoryVerification: {
    orgsSelected: 2,
    orgsFailed: 0,
    orgsReconciled: 1,
    repositoriesAttempted: 7,
    repositoriesVerified: 3,
    repositoriesDenied: 1,
    repositoriesDeferred: 3,
    stoppedOnDeadline: false,
  },
};

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /cron/bootstrap-repo-sync-states", () => {
  it("rejects a request without a valid cron secret and never runs the service", async () => {
    const response = await GET(
      new Request("https://api.test/cron/bootstrap-repo-sync-states", {
        headers: { authorization: "Bearer wrong-secret" },
      })
    );

    expect(response.status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("returns 200 with a summary on success", async () => {
    mocks.run.mockResolvedValue(SUMMARY);

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledOnce();
    const body = await response.text();
    expect(body).toBe(
      "OK: selected 9, bootstrapped 2, partial 1, failed 6, repos 42, repos failed 5, deadline false, verified 3, denied 1"
    );
  });

  it("returns 500 when the service throws", async () => {
    mocks.run.mockRejectedValue(new Error("db down"));

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(500);
  });
});
