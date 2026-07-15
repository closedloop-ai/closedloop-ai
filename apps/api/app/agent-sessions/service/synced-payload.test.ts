import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionsService } from "../service";
import {
  buildAgentSessionDbMock,
  buildAnalyticsScalarRecord,
  installDb,
} from "../service.test-harness";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import("../service.test-mocks");
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import("../service.test-mocks");
  return telemetryModuleMock();
});

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("narrows BigInt token counts above the int4 ceiling to JS numbers", async () => {
    // After widening the token columns to int8 (so a huge synced session no
    // longer overflows int4 and fails the upsert), Postgres returns these as
    // bigint. A count above 2,147,483,647 — the old int4 ceiling — must flow
    // through the analytics read path as a plain JS number, not a bigint leak
    // or NaN.
    const scalarPage = [
      buildAnalyticsScalarRecord(1, {
        inputTokens: 5_000_000_000n,
        outputTokens: 3_000_000_000n,
      }),
    ];

    const findMany = vi
      .fn()
      .mockResolvedValueOnce(scalarPage)
      .mockResolvedValueOnce([]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
      }),
    });

    const analytics = await agentSessionsService.getAnalytics({
      organizationId: "org-1",
      filters: {},
    });

    expect(analytics.byRepository).toEqual([
      {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        sessionCount: 1,
        inputTokens: 5_000_000_000,
        outputTokens: 3_000_000_000,
        estimatedCost: 0.25,
        errorCount: 0,
      },
    ]);
    expect(typeof analytics.byRepository[0]?.inputTokens).toBe("number");
  });
});
