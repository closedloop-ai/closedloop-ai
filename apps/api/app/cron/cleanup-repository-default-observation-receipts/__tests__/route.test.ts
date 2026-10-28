import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deleteMany: vi.fn() }));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: <T>(fn: (db: unknown) => T): T =>
    fn({
      repositoryDefaultObservationReceipt: { deleteMany: mocks.deleteMany },
    }),
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

import { GET } from "../route";

const CRON_SECRET = "test-cron-secret";
const NOW = "2026-10-20T12:00:00.000Z";
/** NOW minus GitHub's 3-day redelivery window, written out as the oracle. */
const CUTOFF = "2026-10-17T12:00:00.000Z";

function request(authorization?: string): Request {
  return new Request(
    "https://api.test/cron/cleanup-repository-default-observation-receipts",
    { headers: authorization ? { authorization } : {} }
  );
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /cron/cleanup-repository-default-observation-receipts", () => {
  it.each([
    ["a wrong", "Bearer wrong-secret"],
    ["a missing", undefined],
  ])("rejects %s cron secret and never deletes", async (_, header) => {
    const response = await GET(request(header));

    expect(response.status).toBe(401);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes only receipts created before the 3-day redelivery window", async () => {
    mocks.deleteMany.mockResolvedValue({ count: 7 });

    const response = await GET(request(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date(CUTOFF) } },
    });
    expect(await response.text()).toBe(
      `OK: deleted 7 receipt(s) created before ${CUTOFF}`
    );
  });

  it("answers 500 when the delete fails, so the cron failure alert fires", async () => {
    mocks.deleteMany.mockRejectedValue(new Error("db down"));

    const response = await GET(request(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(500);
  });
});
