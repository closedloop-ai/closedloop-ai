import { Decimal } from "@repo/database/generated/internal/prismaNamespace";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  buildSessionDetailRecord,
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const UNPRICED_ID = "session-unpriced";
const ZERO_ID = "session-zero";

/**
 * ISS-12260: a NULL `session_detail.estimated_cost` (never priced) is not a
 * stored `$0`. The list read used to coerce it to `0`, so the two rows below
 * came back identical.
 */
describe("ISS-12260: NULL estimated_cost on the Sessions read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves a NULL row's cost as null and a stored 0 as 0 on the list", async () => {
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifactId: UNPRICED_ID,
            estimatedCost: null,
          }),
          buildSessionListRecord({
            artifactId: ZERO_ID,
            estimatedCost: new Decimal(0),
          }),
        ]),
        count: vi.fn().mockResolvedValue(2),
      }),
    });

    const page = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { quality: "all" },
    });
    const byId = new Map(page.items.map((item) => [item.id, item]));
    const unpriced = byId.get(UNPRICED_ID);
    const zero = byId.get(ZERO_ID);

    expect(unpriced).toHaveProperty("estimatedCost", null);
    expect(zero).toHaveProperty("estimatedCost", 0);
    expect(unpriced?.estimatedCost).not.toBe(zero?.estimatedCost);
    // `cost` is unchanged: `formatCurrency` already serves `null` for zero.
    expect(unpriced).toHaveProperty("cost", null);
  });

  it("keeps the null on the detail read, which spreads the list projection", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi
          .fn()
          .mockResolvedValue(buildSessionDetailRecord({ estimatedCost: null })),
      },
    });

    const detail = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(detail).not.toBeNull();
    expect(detail).toHaveProperty("estimatedCost", null);
    expect(detail).toHaveProperty("cost", null);
    expect(detail).toHaveProperty("locPerDollar", null);
  });
});
