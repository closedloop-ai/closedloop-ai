import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
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

// ISS-7343: the gate is what makes this deterministic rather than timing-based.
// The cost split parks until the delivery scan has actually STARTED, so the only
// interleaving that can complete the read is a concurrent one. If the two are ever
// re-serialized (cost split awaited before the delivery scan is issued), the scan
// never starts, the gate never opens, and the case fails on its explicit timeout.
const gate = vi.hoisted(() => {
  let resolveStarted: () => void = () => {
    /* replaced by reset() before every case */
  };
  let started = Promise.resolve();
  return {
    order: [] as string[],
    get started() {
      return started;
    },
    open: () => resolveStarted(),
    reset() {
      this.order.length = 0;
      started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
    },
  };
});

vi.mock("./usage-cost-split", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usage-cost-split")>();
  return {
    ...actual,
    splitSessionCost: vi.fn(
      async (...args: Parameters<typeof actual.splitSessionCost>) => {
        gate.order.push("cost:start");
        await gate.started;
        gate.order.push("cost:end");
        return actual.splitSessionCost(...args);
      }
    ),
  };
});

vi.mock("./usage-owner-lookup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usage-owner-lookup")>();
  return {
    ...actual,
    buildUsageOwnerMap: vi.fn(
      (...args: Parameters<typeof actual.buildUsageOwnerMap>) => {
        gate.order.push("owner:start");
        return actual.buildUsageOwnerMap(...args);
      }
    ),
  };
});

vi.mock("@/lib/agent-session-delivery-metrics", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/agent-session-delivery-metrics")
    >();
  return {
    ...actual,
    collectMergedPrsForScope: vi.fn(() => {
      gate.order.push("delivery:start");
      gate.open();
      return Promise.resolve({ prs: [], mergedBranches: [] });
    }),
  };
});

const START = "2026-07-08T00:00:00.000Z";
const END = "2026-07-14T23:59:59.999Z";

function installDbWithSessions() {
  installDb({
    sessionDetail: buildAgentSessionDbMock({
      aggregate: vi.fn().mockResolvedValue({
        _count: { _all: 10 },
        _sum: {
          inputTokens: 100,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCost: 0,
        },
        _min: { sessionStartedAt: new Date(START) },
        _max: { sessionStartedAt: new Date(END) },
      }),
      groupBy: vi.fn().mockResolvedValue([]),
    }),
    agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
    computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  });
}

describe("agentSessionsService.getUsageSummary — read concurrency (ISS-7343)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.reset();
  });

  it("starts all three independent reads before the cost split resolves", async () => {
    installDbWithSessions();

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: { startDate: START, endDate: END },
    });

    // All THREE reads must have started before the cost split resolves. Asserting
    // the set-before-`cost:end` rather than an exact sequence catches any one of
    // them being pulled back out of the `Promise.all` — the sequential shape this
    // endpoint's p75 paid for before ISS-7343 — without breaking on a harmless
    // reordering of the members themselves.
    const costEndIndex = gate.order.indexOf("cost:end");
    expect(costEndIndex).toBeGreaterThan(-1);
    expect([...gate.order.slice(0, costEndIndex)].sort()).toEqual([
      "cost:start",
      "delivery:start",
      "owner:start",
    ]);
    // Positive sibling: the interleaving above is only meaningful if the read
    // still produced a real summary, so a thrown/short-circuited path cannot
    // satisfy the ordering assertion by never completing the fold.
    expect(summary.totalSessions).toBe(10);
    // `mergedPrCount` is emitted only by the delivery fold, so its presence
    // proves the fold ran on the scan this case interleaved.
    expect(summary).toHaveProperty("mergedPrCount", null);
  }, 10_000);
});
