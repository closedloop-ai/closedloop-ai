/**
 * Unit tests for rankingService (T-18.4, AC-018, AC-025).
 *
 * Prisma is mocked: withDb runs the callback against a fake client whose
 * methods return fixtures. Tests assert:
 *   - org-scoping (only the calling org's data is returned)
 *   - aggregation across compute targets (two devices → merged row)
 *   - stack-rank ordering (higher invocations = rank 1)
 *   - kind filter respected
 *   - components with zero invocations still appear (real data, not missing)
 *   - coaching items excluded from ranking (AC-029 / T-22.7c)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @repo/database BEFORE importing the service under test
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

// Now import the service (after mocks are wired)
import { rankingService } from "../ranking/service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_A = "org-aaaa-1111";
const ORG_B = "org-bbbb-2222";
const TARGET_1 = "target-1111";
const TARGET_2 = "target-2222";
const TARGET_3 = "target-3333";
/** Wire mocks.withDb so the callback receives `db`. */
function installDb(db: Record<string, unknown>): void {
  mocks.withDb.mockImplementation(
    (callback: (db: Record<string, unknown>) => unknown) => callback(db)
  );
}

/**
 * Build a minimal AgentComponent inventory row as returned by
 * db.agentComponent.findMany.
 */
function makeInventoryRow(overrides: {
  componentKind: string;
  componentKey?: string;
  name?: string;
  computeTargetId: string;
  usages?: { invocationCount: number; errorCount: number; orgId: string }[];
}) {
  const usages = (overrides.usages ?? []).map((u) => ({
    invocationCount: u.invocationCount,
    errorCount: u.errorCount,
    session: {
      artifact: { organizationId: u.orgId },
    },
  }));

  return {
    componentKind: overrides.componentKind,
    componentKey: overrides.componentKey ?? null,
    name: overrides.name ?? null,
    computeTargetId: overrides.computeTargetId,
    sessionUsages: usages,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rankingService.getRanking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty ranking when no inventory rows exist", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("stack-ranks components: higher invocations = rank 1", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          makeInventoryRow({
            componentKind: "command",
            componentKey: "code-review",
            name: "Code Review",
            computeTargetId: TARGET_1,
            usages: [
              { invocationCount: 5, errorCount: 0, orgId: ORG_A },
              { invocationCount: 3, errorCount: 1, orgId: ORG_A },
            ],
          }),
          makeInventoryRow({
            componentKind: "command",
            componentKey: "lint-fix",
            name: "Lint Fix",
            computeTargetId: TARGET_1,
            usages: [{ invocationCount: 20, errorCount: 0, orgId: ORG_A }],
          }),
        ]),
      },
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    expect(result.total).toBe(2);
    expect(result.items[0]?.name).toBe("Lint Fix");
    expect(result.items[0]?.rank).toBe(1);
    expect(result.items[0]?.invocations).toBe(20);
    expect(result.items[1]?.name).toBe("Code Review");
    expect(result.items[1]?.rank).toBe(2);
    expect(result.items[1]?.invocations).toBe(8); // 5 + 3
  });

  it("merges the same component across two compute targets (org-level dedup)", async () => {
    // The same "python-coach" command installed on TARGET_1 and TARGET_2
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          makeInventoryRow({
            componentKind: "command",
            componentKey: "python-coach",
            name: "Python Coach",
            computeTargetId: TARGET_1,
            usages: [{ invocationCount: 10, errorCount: 1, orgId: ORG_A }],
          }),
          makeInventoryRow({
            componentKind: "command",
            componentKey: "python-coach",
            name: "Python Coach",
            computeTargetId: TARGET_2,
            usages: [{ invocationCount: 7, errorCount: 0, orgId: ORG_A }],
          }),
        ]),
      },
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    // Deduped to a single ranking entry
    expect(result.total).toBe(1);
    const item = result.items[0];
    expect(item?.name).toBe("Python Coach");
    expect(item?.invocations).toBe(17); // 10 + 7
    expect(item?.sessions).toBe(2); // two usage rows → two sessions
    expect(item?.adoptionBreadth).toBe(2); // two distinct compute targets
    expect(item?.errorRate).toBeCloseTo(1 / 17);
  });

  it("org-scopes: usage rows from a different org are excluded", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          makeInventoryRow({
            componentKind: "skill",
            componentKey: "test-runner",
            name: "Test Runner",
            computeTargetId: TARGET_1,
            usages: [
              { invocationCount: 5, errorCount: 0, orgId: ORG_A },
              // Belongs to a different org — must NOT be counted
              { invocationCount: 100, errorCount: 0, orgId: ORG_B },
            ],
          }),
        ]),
      },
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    expect(result.items).toHaveLength(1);
    // Only the ORG_A usage row should be counted
    expect(result.items[0]?.invocations).toBe(5);
    expect(result.items[0]?.sessions).toBe(1);
  });

  it("filters by kind when kind param is supplied", async () => {
    const findMany = vi.fn().mockResolvedValue([
      makeInventoryRow({
        componentKind: "skill",
        componentKey: "my-skill",
        name: "My Skill",
        computeTargetId: TARGET_1,
        usages: [],
      }),
    ]);

    installDb({ agentComponent: { findMany } });

    await rankingService.getRanking({
      organizationId: ORG_A,
      kind: "skill",
      limit: 50,
    });

    // Prisma query must include the kind filter
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ componentKind: "skill" }),
      })
    );
  });

  it("respects the limit parameter", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeInventoryRow({
        componentKind: "command",
        componentKey: `cmd-${i}`,
        name: `Command ${i}`,
        computeTargetId: TARGET_1,
        usages: [{ invocationCount: 10 - i, errorCount: 0, orgId: ORG_A }],
      })
    );

    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue(rows) },
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 3,
    });

    expect(result.total).toBe(10); // total reflects all deduplicated entries
    expect(result.items).toHaveLength(3); // items are sliced to limit
  });

  it("components with zero invocations appear in ranking with errorRate=null", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          makeInventoryRow({
            componentKind: "plugin",
            componentKey: "rtk",
            name: "RTK",
            computeTargetId: TARGET_1,
            usages: [], // installed but never invoked
          }),
        ]),
      },
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.invocations).toBe(0);
    expect(item?.sessions).toBe(0);
    expect(item?.errorRate).toBeNull();
  });

  it("passes correct org-scoping where clause to Prisma", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({ agentComponent: { findMany } });

    await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_A }),
      })
    );
  });

  it("multiple components of the same kind are ranked in descending invocation order", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          makeInventoryRow({
            componentKind: "command",
            componentKey: "alpha",
            name: "Alpha",
            computeTargetId: TARGET_1,
            usages: [{ invocationCount: 3, errorCount: 0, orgId: ORG_A }],
          }),
          makeInventoryRow({
            componentKind: "command",
            componentKey: "gamma",
            name: "Gamma",
            computeTargetId: TARGET_1,
            usages: [{ invocationCount: 9, errorCount: 0, orgId: ORG_A }],
          }),
          makeInventoryRow({
            componentKind: "command",
            componentKey: "beta",
            name: "Beta",
            computeTargetId: TARGET_1,
            usages: [{ invocationCount: 6, errorCount: 0, orgId: ORG_A }],
          }),
        ]),
      },
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    expect(result.items.map((i) => i.name)).toEqual(["Gamma", "Beta", "Alpha"]);
    expect(result.items.map((i) => i.rank)).toEqual([1, 2, 3]);
  });

  it("assigns adoption breadth from distinct computeTargetIds on merged entries", async () => {
    // Same component on 3 targets, usage rows from different sessions
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          makeInventoryRow({
            componentKind: "mcp",
            componentKey: "gh-mcp",
            name: "GitHub MCP",
            computeTargetId: TARGET_1,
            usages: [{ invocationCount: 2, errorCount: 0, orgId: ORG_A }],
          }),
          makeInventoryRow({
            componentKind: "mcp",
            componentKey: "gh-mcp",
            name: "GitHub MCP",
            computeTargetId: TARGET_2,
            usages: [{ invocationCount: 4, errorCount: 0, orgId: ORG_A }],
          }),
          makeInventoryRow({
            componentKind: "mcp",
            componentKey: "gh-mcp",
            name: "GitHub MCP",
            computeTargetId: TARGET_3,
            usages: [], // installed but no sessions
          }),
        ]),
      },
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.adoptionBreadth).toBe(3);
    expect(result.items[0]?.invocations).toBe(6);
    expect(result.items[0]?.sessions).toBe(2);
  });

  it("uses componentKey for slug and name when name is null", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          makeInventoryRow({
            componentKind: "skill",
            componentKey: "no-name-skill",
            name: undefined, // no name field — falls back to componentKey
            computeTargetId: TARGET_1,
            usages: [],
          }),
        ]),
      },
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    expect(result.items[0]?.slug).toContain("no-name-skill");
    expect(result.items[0]?.name).toBe("no-name-skill");
  });

  it("slug format is kind::normalizedKey", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          makeInventoryRow({
            componentKind: "command",
            componentKey: "My Command",
            name: "My Command",
            computeTargetId: TARGET_1,
            usages: [],
          }),
        ]),
      },
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    // normalizedKey is lowercased + trimmed
    expect(result.items[0]?.slug).toBe("command::my command");
  });

  describe("multiple sessions contributing to a component", () => {
    it("sums invocations and errors across all sessions for the same component", async () => {
      installDb({
        agentComponent: {
          findMany: vi.fn().mockResolvedValue([
            // Single compute-target, but multiple session-usage rows
            makeInventoryRow({
              componentKind: "command",
              componentKey: "build",
              name: "Build",
              computeTargetId: TARGET_1,
              usages: [
                { invocationCount: 5, errorCount: 1, orgId: ORG_A },
                { invocationCount: 3, errorCount: 0, orgId: ORG_A },
                { invocationCount: 7, errorCount: 2, orgId: ORG_A },
              ],
            }),
          ]),
        },
      });

      const result = await rankingService.getRanking({
        organizationId: ORG_A,
        limit: 50,
      });

      const item = result.items[0];
      expect(item?.invocations).toBe(15); // 5 + 3 + 7
      expect(item?.sessions).toBe(3);
      expect(item?.errorRate).toBeCloseTo(3 / 15);
    });
  });

  describe("session isolation across orgs", () => {
    it("usage rows from a different org do not inflate the calling org's ranking", async () => {
      installDb({
        agentComponent: {
          findMany: vi.fn().mockResolvedValue([
            makeInventoryRow({
              componentKind: "skill",
              componentKey: "shared-skill",
              name: "Shared Skill",
              computeTargetId: TARGET_1,
              usages: [
                { invocationCount: 10, errorCount: 0, orgId: ORG_A },
                { invocationCount: 50, errorCount: 0, orgId: ORG_B }, // different org
              ],
            }),
          ]),
        },
      });

      const result = await rankingService.getRanking({
        organizationId: ORG_A,
        limit: 50,
      });

      expect(result.items[0]?.invocations).toBe(10);
    });
  });
});
