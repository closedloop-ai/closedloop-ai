import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocSyncSweepSummary } from "@/app/doc-sync/internal/sweep-service";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/app/doc-sync/internal/sweep-service", () => ({
  docSyncSweepService: { run: mocks.run },
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
  logRequestCompleted: vi.fn(),
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

import { log } from "@repo/observability/log";
import { DOC_SYNC_SWEEP_COMPLETED_EVENT, SWEEP_DEADLINE_MS } from "../handler";
import { GET } from "../route";

const CRON_SECRET = "test-cron-secret";

function summary(
  overrides: Partial<DocSyncSweepSummary> = {}
): DocSyncSweepSummary {
  return {
    scanned: 4,
    deleted: 2,
    kept: 1,
    unparseable: 1,
    failed: 0,
    truncated: false,
    notConfigured: false,
    ...overrides,
  };
}

function request(authorization?: string): Request {
  return new Request("https://api.test/cron/sweep-doc-sync-state", {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /cron/sweep-doc-sync-state", () => {
  it.each([
    ["a wrong", "Bearer wrong-secret"],
    ["a missing", undefined],
  ])("rejects %s cron secret and never sweeps", async (_, header) => {
    const response = await GET(request(header));

    expect(response.status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("sweeps with the deadline, logs the counts and answers 200", async () => {
    const completed = summary();
    mocks.run.mockResolvedValue(completed);

    const response = await GET(request(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledWith({ deadlineMs: SWEEP_DEADLINE_MS });
    expect(log.info).toHaveBeenCalledWith(expect.any(String), {
      event: DOC_SYNC_SWEEP_COMPLETED_EVENT,
      ...completed,
    });
  });

  it.each([
    ["a truncated run", { truncated: true }],
    ["a run with a failed delete", { failed: 1 }],
  ])("answers 500 for %s", async (_, overrides) => {
    mocks.run.mockResolvedValue(summary(overrides));

    const response = await GET(request(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(500);
  });

  it("answers 200 with zero counts when doc-sync is not configured", async () => {
    mocks.run.mockResolvedValue(
      summary({
        scanned: 0,
        deleted: 0,
        kept: 0,
        unparseable: 0,
        notConfigured: true,
      })
    );

    const response = await GET(request(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
  });

  it("answers 500 when the sweep throws", async () => {
    mocks.run.mockRejectedValue(new Error("db down"));

    const response = await GET(request(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(500);
  });
});
