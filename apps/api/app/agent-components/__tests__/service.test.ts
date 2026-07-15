/**
 * T-10.1: Cloud service unit tests for agentComponentsService.
 *
 * Tests:
 * - listForOrg: org-scoping, dedup by (componentKind, componentKey), usage
 *   aggregation, keyset cursor, hook kind with usage=0.
 * - getDetailForOrg: provenance[], usageSessions[] with branch attribution,
 *   404 when not found.
 *
 * AC-009, AC-013
 */
import {
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

// The detail path reuses the agent-sessions read service to populate
// `sessionsTab`; mock it so these tests stay isolated from the (heavy) session
// service and can assert exactly which artifact ids the detail forwarded.
vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: {
    listByArtifactIds: mocks.listByArtifactIds,
  },
}));

import { agentComponentsService } from "../service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installDb(db: Record<string, unknown>) {
  const dbWithDefaults = {
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Orphaned (null-FK) usage fold — defaults to none so existing cases that
    // don't set it keep their FK-linked-only totals.
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    artifactLink: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // KLOC/$ local-git LOC + cost lookup — defaults to none so cases that
    // don't set it report klocPerDollar=null (no fabricated metric).
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...db,
  };
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
}

function buildComputeTarget(
  id: string,
  userId: string,
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null = {
    id: userId,
    firstName: "Ada",
    lastName: "Lovelace",
    email: `${userId}@example.com`,
  }
) {
  return { id, userId, user };
}

function buildInventoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ac-uuid-1",
    organizationId: "org-1",
    computeTargetId: "target-1",
    componentKind: "skill",
    externalComponentId: "skill::my-skill",
    harness: "claude",
    name: "My Skill",
    componentKey: "my-skill",
    sourceUrl: null,
    installPath: null,
    packId: null,
    scope: null,
    projectPath: null,
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-01-10T00:00:00.000Z"),
    computeTarget: buildComputeTarget("target-1", "user-1"),
    sessionUsages: [],
    ...overrides,
  };
}

function buildUsageRow(
  agentSessionId: string,
  invocationCount: number,
  organizationId = "org-1",
  lastInvokedAt: Date | null = null
) {
  return {
    agentSessionId,
    invocationCount,
    lastInvokedAt,
    session: {
      artifactId: agentSessionId,
      userId: "user-1",
      artifact: { organizationId },
    },
  };
}

// ---------------------------------------------------------------------------
// listForOrg tests
// ---------------------------------------------------------------------------

describe("agentComponentsService.listForOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only the calling org's components (org-scoping)", async () => {
    const orgComponentRow = buildInventoryRow({
      id: "ac-org-1",
      organizationId: "org-1",
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([orgComponentRow]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("ac-org-1");
  });

  it("surfaces cloud-authored (sentinel-owned) org-custom agents backfilled from catalog_items (FEA-2923 Gap A)", async () => {
    // A backfilled row: subagent owned by the per-org "cloud" sentinel target,
    // deterministic external id, slug as key, source_repo as sourceUrl.
    const cloudAgentRow = buildInventoryRow({
      id: "ac-cloud-reviewer",
      organizationId: "org-1",
      computeTargetId: "sentinel-org-1",
      componentKind: "subagent",
      externalComponentId: "cloud:agent:legacy-reviewer-1",
      name: "Reviewer",
      componentKey: "reviewer",
      sourceUrl: "github.com/acme/repo",
      // Sentinel owner resolves org scope + owner display like any target.
      computeTarget: buildComputeTarget("sentinel-org-1", "owner-1", {
        id: "owner-1",
        firstName: "Org",
        lastName: "Owner",
        email: "owner-1@example.com",
      }),
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([cloudAgentRow]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      name: "Reviewer",
      kind: "subagent",
      source: "github.com/acme/repo",
      owner: "Org Owner",
      computeTargetIds: ["sentinel-org-1"],
    });
  });

  it("rolls up instance-unique 'Claude subagent <id>' rows into one general-purpose entry (FEA-2923)", async () => {
    // The Claude parser names every typeless subagent spawn uniquely, so
    // pre-rollup installs synced one inventory row per spawn. listForOrg must
    // collapse them to a single 'general-purpose' component at read time.
    const spawnA = buildInventoryRow({
      id: "ac-sub-a",
      computeTargetId: "device-1",
      componentKind: "subagent",
      externalComponentId: "local:claude-subagent-a00eeb0c",
      name: "Claude subagent a00eeb0c",
      componentKey: "Claude subagent a00eeb0c",
      computeTarget: buildComputeTarget("device-1", "owner-1"),
    });
    const spawnB = buildInventoryRow({
      id: "ac-sub-b",
      computeTargetId: "device-1",
      componentKind: "subagent",
      externalComponentId: "local:claude-subagent-a00f43fc",
      name: "Claude subagent a00f43fc",
      componentKey: "Claude subagent a00f43fc",
      computeTarget: buildComputeTarget("device-1", "owner-1"),
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([spawnA, spawnB]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: "subagent",
      name: "general-purpose",
    });
  });

  it("does not roll up a genuinely-typed subagent (subagent_type set)", async () => {
    const typed = buildInventoryRow({
      id: "ac-sub-explore",
      componentKind: "subagent",
      externalComponentId: "local:explore",
      name: "Explore",
      componentKey: "Explore",
      computeTarget: buildComputeTarget("device-1", "owner-1"),
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([typed]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: "subagent",
      name: "Explore",
    });
  });

  it("merges a cloud-authored agent and its device-synced twin into one org entry (shared identity, both provenance targets)", async () => {
    // Same (subagent, reviewer) identity: one backfilled on the sentinel, one
    // synced from a real device. listForOrg dedups by org identity and unions
    // provenance — proving desktop sync and the backfill coexist, not collide.
    const cloudRow = buildInventoryRow({
      id: "ac-cloud",
      computeTargetId: "sentinel-org-1",
      componentKind: "subagent",
      externalComponentId: "cloud:agent:legacy-1",
      name: "Reviewer",
      componentKey: "reviewer",
      computeTarget: buildComputeTarget("sentinel-org-1", "owner-1"),
    });
    const deviceRow = buildInventoryRow({
      id: "ac-device",
      computeTargetId: "device-1",
      componentKind: "subagent",
      externalComponentId: "local:reviewer",
      name: "Reviewer",
      componentKey: "reviewer",
      computeTarget: buildComputeTarget("device-1", "owner-1"),
    });
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([cloudRow, deviceRow]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].computeTargetIds.sort()).toEqual([
      "device-1",
      "sentinel-org-1",
    ]);
  });

  it("does not leak another org's cloud-authored agents (cross-org isolation)", async () => {
    // The service filters agentComponent by organizationId; the sentinel's own
    // organizationId is what scopes it. A row belonging to org-2 must never be
    // returned for org-1 — mirror that by returning [] for the org-1 query.
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({ agentComponent: { findMany } });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(0);
    // The org filter is applied in the DB query, not post-hoc in JS.
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      organizationId: "org-1",
    });
  });

  it("bounds memory: inventory + orphan-usage queries are capped with `take` and ordered deterministically (FEA-2923)", async () => {
    const inventoryFindMany = vi.fn().mockResolvedValue([]);
    const orphanFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: inventoryFindMany },
      agentComponentSessionUsage: { findMany: orphanFindMany },
    });

    await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // Inventory query must be bounded (no unbounded full-org load) and ordered
    // so the cap drops a stable tail.
    const invArgs = inventoryFindMany.mock.calls[0]?.[0];
    expect(typeof invArgs?.take).toBe("number");
    expect(invArgs?.take).toBeGreaterThan(0);
    expect(invArgs?.orderBy).toBeDefined();

    // Orphan-usage fold must also be bounded.
    const orphanArgs = orphanFindMany.mock.calls[0]?.[0];
    expect(typeof orphanArgs?.take).toBe("number");
    expect(orphanArgs?.take).toBeGreaterThan(0);
  });

  it("deduplicates two compute-target rows with the same (componentKind, componentKey) into one org-level entry", async () => {
    const sharedKind = "command";
    const sharedKey = "code-review";
    const row1 = buildInventoryRow({
      id: "ac-target1",
      computeTargetId: "target-1",
      componentKind: sharedKind,
      componentKey: sharedKey,
      name: "Code Review",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [buildUsageRow("sess-1", 3)],
    });
    const row2 = buildInventoryRow({
      id: "ac-target2",
      computeTargetId: "target-2",
      componentKind: sharedKind,
      componentKey: sharedKey,
      name: "Code Review",
      computeTarget: buildComputeTarget("target-2", "user-2", {
        id: "user-2",
        firstName: "Bob",
        lastName: "Smith",
        email: "bob@example.com",
      }),
      sessionUsages: [buildUsageRow("sess-2", 7)],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row1, row2]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // Should be deduplicated to a single org-level entry
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item).toBeDefined();
    // Both compute targets should be listed in provenance
    expect(item?.computeTargetIds).toContain("target-1");
    expect(item?.computeTargetIds).toContain("target-2");
  });

  it("aggregates invocationCount org-wide across all inventory rows", async () => {
    const row1 = buildInventoryRow({
      id: "ac-1",
      componentKind: "skill",
      componentKey: "my-skill",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [buildUsageRow("sess-1", 5)],
    });
    const row2 = buildInventoryRow({
      id: "ac-2",
      computeTargetId: "target-2",
      componentKind: "skill",
      componentKey: "my-skill",
      computeTarget: buildComputeTarget("target-2", "user-2", {
        id: "user-2",
        firstName: "Carol",
        lastName: null,
        email: "carol@example.com",
      }),
      sessionUsages: [buildUsageRow("sess-2", 10)],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row1, row2]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // 5 + 10 = 15 total across the org
    expect(result.items[0]?.invocations).toBe(15);
  });

  it("projects lastInvokedAt as the max usage lastInvokedAt across all inventory rows (FEA-3179)", async () => {
    const older = new Date("2026-03-01T00:00:00.000Z");
    const newer = new Date("2026-03-05T12:00:00.000Z");
    const row1 = buildInventoryRow({
      id: "ac-1",
      componentKind: "skill",
      componentKey: "my-skill",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [buildUsageRow("sess-1", 5, "org-1", older)],
    });
    const row2 = buildInventoryRow({
      id: "ac-2",
      computeTargetId: "target-2",
      componentKind: "skill",
      componentKey: "my-skill",
      computeTarget: buildComputeTarget("target-2", "user-2", {
        id: "user-2",
        firstName: "Carol",
        lastName: null,
        email: "carol@example.com",
      }),
      // The later invocation must win regardless of row order.
      sessionUsages: [buildUsageRow("sess-2", 10, "org-1", newer)],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row1, row2]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // Real usage recency, NOT the inventory lastSeenAt (which is 2026-01-10).
    expect(result.items[0]?.lastInvokedAt).toBe(newer.toISOString());
  });

  it("omits lastInvokedAt for a component with no usage rows (FEA-3179)", async () => {
    // An installed component that has never been invoked (no usage rows) must
    // NOT carry a lastInvokedAt — so the "active" dot never lights off the
    // sync-refreshed lastSeenAt.
    const row = buildInventoryRow({
      id: "ac-never-used",
      componentKind: "config",
      componentKey: "settings",
      name: "Settings",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.lastInvokedAt).toBeUndefined();
  });

  it("folds orphaned (null-FK) usage into the matching entry's totals", async () => {
    const row = buildInventoryRow({
      id: "ac-1",
      componentKind: "skill",
      componentKey: "my-skill",
      name: "My Skill",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      // FK-linked usage on this inventory row
      sessionUsages: [buildUsageRow("sess-linked", 4)],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row]),
      },
      // A usage row synced before the inventory row was linked (agentComponentId
      // null). Matched to the entry by (kind, componentKey).
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          {
            agentSessionId: "sess-orphan",
            componentKind: "skill",
            componentKey: "my-skill",
            invocationCount: 6,
          },
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // 4 (linked) + 6 (orphan) = 10 invocations; two distinct sessions.
    expect(result.items[0]?.invocations).toBe(10);
    expect(result.items[0]?.sessions).toBe(2);
  });

  it("surfaces a component that exists only as session usage (no inventory row) — Gap B", async () => {
    // No inventory rows at all: the component was USED in parsed sessions but
    // never collected as installed inventory. Session-sync delivered the usage
    // as an orphan (null-FK) row. It must still appear in the list.
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          {
            agentSessionId: "sess-orphan",
            componentKind: "skill",
            componentKey: "used-only-skill",
            harness: "claude",
            invocationCount: 9,
            firstInvokedAt: new Date("2026-03-01T00:00:00.000Z"),
            lastInvokedAt: new Date("2026-03-05T00:00:00.000Z"),
          },
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    // Falls back to componentKey for the label (usage row has no name).
    expect(item?.name).toBe("used-only-skill");
    expect(item?.kind).toBe("skill");
    expect(item?.harness).toBe("claude");
    expect(item?.invocations).toBe(9);
    expect(item?.sessions).toBe(1);
    // No installed inventory ⇒ no compute-target provenance.
    expect(item?.computeTargetIds).toEqual([]);
    // Timestamps seeded from invocation times.
    expect(item?.firstSeenAt).toBe("2026-03-01T00:00:00.000Z");
    expect(item?.lastSeenAt).toBe("2026-03-05T00:00:00.000Z");
  });

  it("merges (not duplicates) a synthetic orphan entry into a matching inventory row", async () => {
    // Same (kind, key) exists both as an inventory row and as an orphan usage
    // row. The list must collapse to ONE entry, summing usage.
    const row = buildInventoryRow({
      id: "ac-inv-1",
      componentKind: "skill",
      componentKey: "shared-skill",
      name: "Shared Skill",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [buildUsageRow("sess-linked", 4)],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          {
            agentSessionId: "sess-orphan",
            componentKind: "skill",
            componentKey: "shared-skill",
            harness: "claude",
            invocationCount: 6,
            firstInvokedAt: null,
            lastInvokedAt: null,
          },
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // One merged entry (the real inventory row wins as canonical), not two.
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.id).toBe("ac-inv-1");
    expect(item?.name).toBe("Shared Skill");
    // 4 (linked) + 6 (orphan) = 10, across two distinct sessions.
    expect(item?.invocations).toBe(10);
    expect(item?.sessions).toBe(2);
  });

  it("does not leak another org's orphan usage as a synthetic entry (cross-org isolation)", async () => {
    // The orphan-usage query is org-scoped through SessionDetail.organizationId,
    // so another org's usage never reaches this org's list. The mock returns
    // only org-1 rows to mirror that filter; assert the foreign component is
    // absent regardless.
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentComponentSessionUsage: {
        findMany: vi
          .fn()
          .mockImplementation((args: { where?: { session?: unknown } }) => {
            // Belt-and-suspenders: the query must be org-scoped via the session
            // relation, else cross-org usage could leak.
            expect(args?.where?.session).toBeDefined();
            return Promise.resolve([
              {
                agentSessionId: "sess-org1",
                componentKind: "skill",
                componentKey: "org1-skill",
                harness: "claude",
                invocationCount: 2,
                firstInvokedAt: null,
                lastInvokedAt: null,
              },
            ]);
          }),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // Only org-1's component surfaces; no org-2 component leaks in.
    expect(result.items).toHaveLength(1);
    expect(result.items.map((i) => i.name)).toEqual(["org1-skill"]);
  });

  it("orders equal-sort-key rows deterministically by id (stable paging)", async () => {
    // Three entries with identical invocation counts (0) and names — the
    // primary sort ties, so only the id tiebreaker keeps paging stable.
    const rows = ["ac-c", "ac-a", "ac-b"].map((id) =>
      buildInventoryRow({
        id,
        componentKind: "skill",
        componentKey: id, // distinct keys => distinct entries
        name: "same-name",
        computeTarget: buildComputeTarget("target-1", "user-1"),
        sessionUsages: [],
      })
    );

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue(rows),
      },
    });

    const page1 = await agentComponentsService.listForOrg("org-1", {
      limit: 2,
      offset: 0,
      sortBy: AgentComponentSortKey.Name,
      sortDir: AgentComponentSortDir.Asc,
    });
    const page2 = await agentComponentsService.listForOrg("org-1", {
      limit: 2,
      offset: 2,
      sortBy: AgentComponentSortKey.Name,
      sortDir: AgentComponentSortDir.Asc,
    });

    // Ascending id order across the page boundary: no skips or repeats.
    expect(page1.items.map((i) => i.id)).toEqual(["ac-a", "ac-b"]);
    expect(page2.items.map((i) => i.id)).toEqual(["ac-c"]);
  });

  it("returns hasMore=true when there are more results beyond the page", async () => {
    // 3 rows with same kind+key would dedup to 1 org-level entry;
    // use distinct keys for independent entries to test pagination
    const rows = ["skill-a", "skill-b", "skill-c"].map((key, i) =>
      buildInventoryRow({
        id: `ac-${i}`,
        componentKind: "skill",
        componentKey: key,
        name: key,
        computeTarget: buildComputeTarget("target-1", "user-1"),
        sessionUsages: [],
      })
    );

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue(rows),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 2,
      offset: 0,
    });

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
  });

  it("returns usage=0 for hook kind (on-read derivation — zero usage is real, not missing)", async () => {
    const hookRow = buildInventoryRow({
      id: "ac-hook-1",
      componentKind: "hook",
      componentKey: "pre-commit",
      name: "pre-commit",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [], // Hooks have zero usage rows — this is correct, not missing
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([hookRow]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.invocations).toBe(0);
    expect(result.items[0]?.sessions).toBe(0);
  });

  it("filters out usage rows from another org (belt-and-suspenders org guard)", async () => {
    const row = buildInventoryRow({
      id: "ac-1",
      componentKind: "command",
      componentKey: "test-cmd",
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [
        // This usage row belongs to org-2, not org-1
        buildUsageRow("sess-other", 99, "org-2"),
        // This usage row belongs to org-1
        buildUsageRow("sess-1", 3, "org-1"),
      ],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([row]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // Only org-1 usage should be counted
    expect(result.items[0]?.invocations).toBe(3);
  });

  it("returns an empty list when no components exist for the org", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("rolls up child usage into a plugin's invocations/sessions by pack_id (soul review HIGH)", async () => {
    // A plugin inventory row (packId = "rtk") with NO usage rows of its own —
    // the real sync pipeline never materializes plugin-kind usage. Its
    // invocations/sessions must come from its CHILD components' usage, matching
    // the desktop reader's pack_id rollup so both surfaces agree.
    const pluginRow = buildInventoryRow({
      id: "ac-plugin-rtk",
      componentKind: "plugin",
      externalComponentId: "plugin::rtk",
      name: "RTK",
      componentKey: "rtk",
      packId: "rtk",
      sessionUsages: [],
    });

    // Child skill usage rows (the FK-linked usage that DOES sync): 2 sessions,
    // 5 total invocations across the pack. `agentComponentSessionUsage.findMany`
    // is called twice — once for the orphan fold (agentComponentId: null) and
    // once for the plugin child rollup (agentComponent.packId in [...]). Route
    // each call by its `where` shape.
    const childUsage = [
      {
        agentSessionId: "sess-1",
        invocationCount: 3,
        agentComponent: { packId: "rtk" },
      },
      {
        agentSessionId: "sess-2",
        invocationCount: 2,
        agentComponent: { packId: "rtk" },
      },
    ];
    const usageFindMany = vi
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        // Plugin child rollup query filters on the child's packId relation.
        if (where.agentComponent) {
          return Promise.resolve(childUsage);
        }
        // Orphan-usage fold query (agentComponentId: null) — none here.
        return Promise.resolve([]);
      });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([pluginRow]),
      },
      agentComponentSessionUsage: {
        findMany: usageFindMany,
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    const plugin = result.items[0];
    expect(plugin.kind).toBe("plugin");
    // 3 + 2 child invocations rolled up (NOT the plugin's own 0 usage rows).
    expect(plugin.invocations).toBe(5);
    // 2 distinct child sessions.
    expect(plugin.sessions).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// FEA-3160: server-side USAGE time-window (startDate) tests
// ---------------------------------------------------------------------------

/**
 * A usage row carrying `lastInvokedAt`, the field the FEA-3160 window predicate
 * filters on. The window DB read scopes `sessionUsages` to
 * `lastInvokedAt >= startDate`; these tests supply rows whose usage the mock has
 * ALREADY filtered (mirroring what Prisma would return), plus assert the
 * predicate reaches the query.
 */
function buildWindowedUsageRow(
  agentSessionId: string,
  invocationCount: number,
  lastInvokedAt: string
) {
  return {
    agentSessionId,
    invocationCount,
    lastInvokedAt: new Date(lastInvokedAt),
    session: {
      artifactId: agentSessionId,
      userId: "user-1",
      artifact: { organizationId: "org-1" },
    },
  };
}

describe("agentComponentsService.listForOrg — startDate windowing (FEA-3160)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const START = "2026-06-01T00:00:00.000Z";

  it("threads startDate into every usage-lane where clause", async () => {
    const inventoryFindMany = vi.fn().mockResolvedValue([]);
    const usageFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: inventoryFindMany },
      agentComponentSessionUsage: { findMany: usageFindMany },
    });

    await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      startDate: START,
    });

    // Inventory query: the sessionUsages relation is windowed by lastInvokedAt.
    const invWhere =
      inventoryFindMany.mock.calls[0]?.[0]?.select?.sessionUsages?.where;
    expect(invWhere?.lastInvokedAt).toEqual({ gte: new Date(START) });

    // Orphan-usage fold: also windowed.
    const orphanWhere = usageFindMany.mock.calls[0]?.[0]?.where;
    expect(orphanWhere?.lastInvokedAt).toEqual({ gte: new Date(START) });
  });

  it("does NOT add a window predicate when startDate is absent (all-time)", async () => {
    const inventoryFindMany = vi.fn().mockResolvedValue([]);
    const usageFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: inventoryFindMany },
      agentComponentSessionUsage: { findMany: usageFindMany },
    });

    await agentComponentsService.listForOrg("org-1", { limit: 50, offset: 0 });

    const invWhere =
      inventoryFindMany.mock.calls[0]?.[0]?.select?.sessionUsages?.where;
    expect(invWhere?.lastInvokedAt).toBeUndefined();
    const orphanWhere = usageFindMany.mock.calls[0]?.[0]?.where;
    expect(orphanWhere?.lastInvokedAt).toBeUndefined();
  });

  it("with startDate: a component whose only usage is BEFORE the window is dropped (zero in-window)", async () => {
    // Two components. The mock returns their sessionUsages already filtered by
    // the window (as Prisma would): the stale one has NO in-window usage rows,
    // the active one keeps its in-window row.
    const stale = buildInventoryRow({
      id: "ac-stale",
      componentKind: "skill",
      componentKey: "stale-skill",
      name: "Stale Skill",
      // Simulate DB-side windowing: no rows survive the lastInvokedAt filter.
      sessionUsages: [],
    });
    const active = buildInventoryRow({
      id: "ac-active",
      componentKind: "skill",
      componentKey: "active-skill",
      name: "Active Skill",
      sessionUsages: [
        buildWindowedUsageRow("sess-in", 8, "2026-06-15T00:00:00.000Z"),
      ],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([stale, active]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      startDate: START,
    });

    // The stale component (zero in-window usage) is dropped; only the active
    // one survives, with its windowed invocation total.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("Active Skill");
    expect(result.items[0]?.invocations).toBe(8);
    expect(result.items[0]?.sessions).toBe(1);
  });

  it("with startDate: hook/config components (no usage-tracking signal) survive the window while a zero-in-window usage-trackable component is dropped", async () => {
    // hook/config kinds are never materialized into AgentComponentSessionUsage,
    // so they ALWAYS report zero usage by design. A windowed query must keep
    // them visible (dropping them would erase the whole kind under any window),
    // while a usage-trackable skill with no in-window usage is still dropped.
    const hook = buildInventoryRow({
      id: "ac-hook",
      componentKind: "hook",
      componentKey: "pre-commit-hook",
      name: "Pre-commit Hook",
      // No usage rows exist for hooks (by design).
      sessionUsages: [],
    });
    const config = buildInventoryRow({
      id: "ac-config",
      componentKind: "config",
      componentKey: "claude-config",
      name: "Claude Config",
      sessionUsages: [],
    });
    const staleSkill = buildInventoryRow({
      id: "ac-stale-skill",
      componentKind: "skill",
      componentKey: "stale-skill",
      name: "Stale Skill",
      // Usage-trackable but no rows survive the window filter.
      sessionUsages: [],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([hook, config, staleSkill]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      startDate: START,
    });

    // Hook + config survive despite zero windowed usage; the stale skill is
    // dropped for having zero in-window usage on a usage-trackable kind.
    const names = result.items.map((i) => i.name).sort();
    expect(names).toEqual(["Claude Config", "Pre-commit Hook"]);
    const kinds = result.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["config", "hook"]);
    // The surviving zero-usage kinds honestly report zero usage.
    for (const item of result.items) {
      expect(item.invocations).toBe(0);
      expect(item.sessions).toBe(0);
    }
  });

  it("without startDate: a zero-usage component is KEPT (all-time inventory view unchanged)", async () => {
    const zeroUsage = buildInventoryRow({
      id: "ac-zero",
      componentKind: "skill",
      componentKey: "zero-skill",
      name: "Zero Usage Skill",
      sessionUsages: [],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([zeroUsage]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // No window ⇒ the inventory row surfaces even with zero usage.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("Zero Usage Skill");
    expect(result.items[0]?.invocations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FEA-3178: server-side USAGE upper-bound (endDate) windowing tests. Mirrors the
// startDate suite above — the preceding-period query the summary-card delta uses
// sends BOTH bounds (startDate=prevStart, endDate=prevEnd) so the two windows do
// not overlap.
// ---------------------------------------------------------------------------

describe("agentComponentsService.listForOrg — endDate windowing (FEA-3178)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PREV_START = "2026-04-01T00:00:00.000Z";
  const PREV_END = "2026-05-01T00:00:00.000Z";

  it("threads endDate (lte) alongside startDate (gte) into every usage-lane where clause", async () => {
    const inventoryFindMany = vi.fn().mockResolvedValue([]);
    const usageFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: inventoryFindMany },
      agentComponentSessionUsage: { findMany: usageFindMany },
    });

    await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      startDate: PREV_START,
      endDate: PREV_END,
    });

    // Inventory query: the sessionUsages relation carries BOTH bounds.
    const invWhere =
      inventoryFindMany.mock.calls[0]?.[0]?.select?.sessionUsages?.where;
    expect(invWhere?.lastInvokedAt).toEqual({
      gte: new Date(PREV_START),
      lte: new Date(PREV_END),
    });

    // Orphan-usage fold: also bounded on both sides.
    const orphanWhere = usageFindMany.mock.calls[0]?.[0]?.where;
    expect(orphanWhere?.lastInvokedAt).toEqual({
      gte: new Date(PREV_START),
      lte: new Date(PREV_END),
    });
  });

  it("supports endDate WITHOUT startDate (upper bound only ⇒ lte only)", async () => {
    const inventoryFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: inventoryFindMany },
    });

    await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      endDate: PREV_END,
    });

    const invWhere =
      inventoryFindMany.mock.calls[0]?.[0]?.select?.sessionUsages?.where;
    expect(invWhere?.lastInvokedAt).toEqual({ lte: new Date(PREV_END) });
  });

  it("does NOT add any window predicate when both bounds are absent (all-time)", async () => {
    const inventoryFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponent: { findMany: inventoryFindMany },
    });

    await agentComponentsService.listForOrg("org-1", { limit: 50, offset: 0 });

    const invWhere =
      inventoryFindMany.mock.calls[0]?.[0]?.select?.sessionUsages?.where;
    expect(invWhere?.lastInvokedAt).toBeUndefined();
  });

  it("with a bounded [start,end] window: a component with zero in-window usage is dropped", async () => {
    // The mock returns each component's sessionUsages already filtered by the
    // window (as Prisma would): the stale one has no surviving rows, the active
    // one keeps its in-window row.
    const stale = buildInventoryRow({
      id: "ac-stale",
      componentKind: "skill",
      componentKey: "stale-skill",
      name: "Stale Skill",
      sessionUsages: [],
    });
    const active = buildInventoryRow({
      id: "ac-active",
      componentKind: "skill",
      componentKey: "active-skill",
      name: "Active Skill",
      sessionUsages: [
        buildWindowedUsageRow("sess-prev", 5, "2026-04-15T00:00:00.000Z"),
      ],
    });

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([stale, active]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
      startDate: PREV_START,
      endDate: PREV_END,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("Active Skill");
    expect(result.items[0]?.invocations).toBe(5);
    expect(result.items[0]?.sessions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// KLOC/$ efficiency metric (FEA-2923 follow-up)
// ---------------------------------------------------------------------------

function buildSessionDetailRow(
  artifactId: string,
  linesAdded: number | null,
  linesRemoved: number | null,
  estimatedCost: number
) {
  return { artifactId, linesAdded, linesRemoved, estimatedCost };
}

describe("agentComponentsService.listForOrg — klocPerDollar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes klocPerDollar = (linesAdded+linesRemoved)/1000 / summed cost across the component's sessions", async () => {
    const row = buildInventoryRow({
      id: "ac-kloc",
      componentKind: "skill",
      componentKey: "my-skill",
      sessionUsages: [buildUsageRow("sess-1", 4), buildUsageRow("sess-2", 6)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          // 900 + 100 = 1000 lines total, $2.00 total cost across two sessions.
          buildSessionDetailRow("sess-1", 700, 200, 1.5),
          buildSessionDetailRow("sess-2", 80, 20, 0.5),
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // (1000 / 1000) / 2.00 = 0.5 KLOC per dollar.
    expect(result.items[0]?.klocPerDollar).toBeCloseTo(0.5, 6);
  });

  it("counts a session's LOC + cost exactly once even when it has multiple usage rows (no double-count)", async () => {
    // Two usage rows for the SAME session (e.g. per-branch buckets) must not
    // count that session's LOC/cost twice.
    const row = buildInventoryRow({
      id: "ac-dedup",
      componentKind: "skill",
      componentKey: "dedup-skill",
      sessionUsages: [buildUsageRow("sess-1", 3), buildUsageRow("sess-1", 2)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([buildSessionDetailRow("sess-1", 400, 100, 1)]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // (500 / 1000) / 1 = 0.5 — NOT 1.0 (which double-counting would produce).
    expect(result.items[0]?.klocPerDollar).toBeCloseTo(0.5, 6);
  });

  it("returns klocPerDollar=null when the sessions' summed cost is 0 (no divide-by-zero, no fabricated number)", async () => {
    const row = buildInventoryRow({
      id: "ac-zero-cost",
      componentKind: "skill",
      componentKey: "free-skill",
      sessionUsages: [buildUsageRow("sess-1", 5)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([buildSessionDetailRow("sess-1", 500, 0, 0)]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items[0]?.klocPerDollar).toBeNull();
  });

  it("returns klocPerDollar=null when the sessions produced no measurable lines", async () => {
    const row = buildInventoryRow({
      id: "ac-no-loc",
      componentKind: "skill",
      componentKey: "no-loc-skill",
      sessionUsages: [buildUsageRow("sess-1", 5)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([buildSessionDetailRow("sess-1", 0, 0, 2)]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items[0]?.klocPerDollar).toBeNull();
  });

  it("returns klocPerDollar=null for a component whose sessions have no SessionDetail LOC/cost rows", async () => {
    const row = buildInventoryRow({
      id: "ac-missing",
      componentKind: "skill",
      componentKey: "missing-skill",
      sessionUsages: [buildUsageRow("sess-1", 5)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      // sessionDetail.findMany defaults to [] — no LOC/cost available.
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items[0]?.klocPerDollar).toBeNull();
  });

  it("scopes the SessionDetail LOC/cost lookup to the org via the parent artifact", async () => {
    const sessionDetailFindMany = vi.fn().mockResolvedValue([]);
    const row = buildInventoryRow({
      id: "ac-scope",
      sessionUsages: [buildUsageRow("sess-1", 1)],
    });
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([row]) },
      sessionDetail: { findMany: sessionDetailFindMany },
    });

    await agentComponentsService.listForOrg("org-1", { limit: 50, offset: 0 });

    const where = sessionDetailFindMany.mock.calls[0]?.[0]?.where;
    // Org scope must go through the parent artifact (SessionDetail has no
    // organizationId column of its own).
    expect(where?.artifact).toMatchObject({ organizationId: "org-1" });
  });
});

// ---------------------------------------------------------------------------
// getDetailForOrg tests
// ---------------------------------------------------------------------------

describe("agentComponentsService.getDetailForOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the sessions read service returns no summaries. Individual tests
    // override this to assert sessionsTab population + the forwarded ids.
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("returns null (404) when no inventory rows match the slug", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::nonexistent"
    );

    expect(result).toBeNull();
  });

  it("returns null for an invalid slug format (no :: separator)", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "invalid-slug-no-separator"
    );

    expect(result).toBeNull();
  });

  it("includes all compute targets in provenance[]", async () => {
    const detailRow1 = {
      id: "ac-1",
      computeTargetId: "target-1",
      componentKind: "skill",
      componentKey: "my-skill",
      externalComponentId: "skill::my-skill",
      harness: "claude",
      name: "My Skill",
      sourceUrl: null,
      installPath: "/home/user/.skills/my-skill",
      scope: "user",
      projectPath: null,
      description: "A test skill",
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [],
    };
    const detailRow2 = {
      ...detailRow1,
      id: "ac-2",
      computeTargetId: "target-2",
      installPath: "/home/user2/.skills/my-skill",
      scope: "project",
      computeTarget: buildComputeTarget("target-2", "user-2", {
        id: "user-2",
        firstName: "Bob",
        lastName: null,
        email: "bob@example.com",
      }),
      sessionUsages: [],
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow1, detailRow2]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result).not.toBeNull();
    expect(result?.provenance).toHaveLength(2);
    const provenanceIds = result?.provenance.map((p) => p.computeTargetId);
    expect(provenanceIds).toContain("target-1");
    expect(provenanceIds).toContain("target-2");
  });

  it("builds usageSessions[] with branch attribution via on-read artifact_link join", async () => {
    const sessionId = "session-abc";
    const detailRow = {
      id: "ac-1",
      computeTargetId: "target-1",
      componentKind: "command",
      componentKey: "code-review",
      externalComponentId: "command::code-review",
      harness: "claude",
      name: "Code Review",
      sourceUrl: null,
      installPath: null,
      scope: null,
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 8,
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    const branchLinkRow = {
      sourceId: sessionId,
      metadata: {
        linkKind: "session_branch",
        branchName: "fea-2923",
      },
      target: {
        branch: { branchName: "fea-2923" },
      },
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([branchLinkRow]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "command::code-review"
    );

    expect(result).not.toBeNull();
    expect(result?.usageSessions).toHaveLength(1);
    expect(result?.usageSessions[0]).toMatchObject({
      sessionId,
      invocationCount: 8,
      branchName: "fea-2923",
    });
  });

  it("returns usageSessions[] with branchName=null when no branch link exists", async () => {
    const sessionId = "session-no-branch";
    const detailRow = {
      id: "ac-1",
      computeTargetId: "target-1",
      componentKind: "skill",
      componentKey: "my-skill",
      externalComponentId: "skill::my-skill",
      harness: "claude",
      name: "My Skill",
      sourceUrl: null,
      installPath: null,
      scope: null,
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 3,
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::my-skill"
    );

    expect(result?.usageSessions[0]?.branchName).toBeNull();
    expect(result?.usageSessions[0]?.invocationCount).toBe(3);
  });

  it("FEA-2990: splits one session's usage per-event branch, overriding the session-level link", async () => {
    // A single session ran this component on two branches (checkout mid-run).
    // The desktop materialized one usage row per (component, branch); the cloud
    // must surface BOTH branches at invocation granularity instead of crediting
    // the whole session to the single session-level SessionBranch link.
    const sessionId = "session-multi-branch";
    const detailRow = {
      id: "ac-1",
      computeTargetId: "target-1",
      componentKind: "tool",
      componentKey: "Bash",
      externalComponentId: "tool::Bash",
      harness: "claude",
      name: "Bash",
      sourceUrl: null,
      installPath: null,
      scope: null,
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 4,
          gitBranch: "feat/a",
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
        {
          agentSessionId: sessionId,
          invocationCount: 9,
          gitBranch: "feat/b",
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    // Session-level link points at a THIRD branch — it must NOT win over the
    // per-event branches. A branch-dropping (session-level-only) implementation
    // would emit a single row attributed to this stale branch, failing below.
    const branchLinkRow = {
      sourceId: sessionId,
      metadata: {
        linkKind: "session_branch",
        branchName: "session-level-stale",
      },
      target: { branch: { branchName: "session-level-stale" } },
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([branchLinkRow]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "tool::Bash"
    );

    expect(result).not.toBeNull();
    // Two entries — one per branch actually run on — not one session-level row.
    expect(result?.usageSessions).toHaveLength(2);
    const byBranch = new Map(
      result?.usageSessions.map((u) => [u.branchName, u.invocationCount])
    );
    expect(byBranch.get("feat/a")).toBe(4);
    expect(byBranch.get("feat/b")).toBe(9);
    // The stale session-level branch never appears for these precise buckets.
    expect(byBranch.has("session-level-stale")).toBe(false);
    // Aggregate total still counts every invocation.
    expect(result?.invocations).toBe(13);
  });

  it("FEA-2990: a branch-less ('' sentinel) usage bucket falls back to the session-level SessionBranch link", async () => {
    // Legacy/Codex usage carries no per-event branch (gitBranch ''), so the
    // session-level SessionBranch link must still supply the attribution — no
    // regression for pre-column data.
    const sessionId = "session-legacy";
    const detailRow = {
      id: "ac-1",
      computeTargetId: "target-1",
      componentKind: "tool",
      componentKey: "Bash",
      externalComponentId: "tool::Bash",
      harness: "codex",
      name: "Bash",
      sourceUrl: null,
      installPath: null,
      scope: null,
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 6,
          gitBranch: "",
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    const branchLinkRow = {
      sourceId: sessionId,
      metadata: {
        linkKind: "session_branch",
        branchName: "legacy-branch",
      },
      target: { branch: { branchName: "legacy-branch" } },
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([branchLinkRow]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "tool::Bash"
    );

    expect(result?.usageSessions).toHaveLength(1);
    expect(result?.usageSessions[0]).toMatchObject({
      sessionId,
      invocationCount: 6,
      branchName: "legacy-branch",
    });
  });

  it("FEA-2990: merges the '' fallback bucket into a real per-event bucket of the same branch (no double-count)", async () => {
    // A session has BOTH a branch-less ('' sentinel) bucket AND a real per-event
    // bucket, and the session-level SessionBranch link resolves '' to that SAME
    // real branch. Naively pushing one row per bucket would emit two rows both
    // named "feat/x", and the detail/token-trend sum-over-rows would then
    // double-count. buildUsageSessions must fold by RESOLVED branch and sum.
    const sessionId = "session-collide";
    const detailRow = {
      id: "ac-1",
      computeTargetId: "target-1",
      componentKind: "tool",
      componentKey: "Bash",
      externalComponentId: "tool::Bash",
      harness: "claude",
      name: "Bash",
      sourceUrl: null,
      installPath: null,
      scope: null,
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 5,
          gitBranch: "feat/x",
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
        {
          agentSessionId: sessionId,
          invocationCount: 2,
          gitBranch: "",
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    // Session-level link resolves the '' bucket to "feat/x" — the SAME branch as
    // the real per-event bucket, forcing the collision.
    const branchLinkRow = {
      sourceId: sessionId,
      metadata: {
        linkKind: "session_branch",
        branchName: "feat/x",
      },
      target: { branch: { branchName: "feat/x" } },
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([branchLinkRow]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "tool::Bash"
    );

    expect(result).not.toBeNull();
    // ONE merged row for feat/x, not two — the '' bucket folds into the real one.
    expect(result?.usageSessions).toHaveLength(1);
    expect(result?.usageSessions[0]).toMatchObject({
      sessionId,
      branchName: "feat/x",
      invocationCount: 7,
    });
  });

  it("returns the detail with id matching the first inventory row", async () => {
    const detailRow = {
      id: "canonical-uuid-1",
      computeTargetId: "target-1",
      componentKind: "mcp",
      componentKey: "my-mcp",
      externalComponentId: "mcp::my-mcp",
      harness: "claude",
      name: "My MCP",
      sourceUrl: "https://example.com/mcp",
      installPath: null,
      scope: null,
      projectPath: null,
      description: "Test MCP server",
      firstSeenAt: new Date("2026-02-01"),
      lastSeenAt: new Date("2026-02-15"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [],
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "mcp::my-mcp"
    );

    expect(result?.id).toBe("canonical-uuid-1");
    expect(result?.name).toBe("My MCP");
    expect(result?.kind).toBe("mcp");
    // firstSeenAt and lastSeenAt are ISO strings on the response
    expect(result?.firstSeenAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result?.lastSeenAt).toBe("2026-02-15T00:00:00.000Z");
  });

  it("populates sessionsTab from the usage→session join (FEA-2923: not hardcoded [])", async () => {
    const sessionId = "session-sessions-tab";
    const detailRow = {
      id: "ac-1",
      computeTargetId: "target-1",
      componentKind: "command",
      componentKey: "code-review",
      externalComponentId: "command::code-review",
      harness: "claude",
      name: "Code Review",
      sourceUrl: null,
      installPath: null,
      scope: null,
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [
        {
          agentSessionId: sessionId,
          invocationCount: 5,
          session: {
            artifactId: sessionId,
            artifact: { organizationId: "org-1" },
          },
        },
      ],
    };

    // The agent-sessions read service returns a real list-item summary; the
    // detail must surface it as sessionsTab (previously hardcoded []).
    const sessionSummary = { id: sessionId, name: "Code Review Session" };
    mocks.listByArtifactIds.mockResolvedValue([sessionSummary]);

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([detailRow]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "command::code-review"
    );

    // sessionsTab must be populated from the reused session service, org-scoped,
    // for exactly the session ids that invoked the component.
    expect(mocks.listByArtifactIds).toHaveBeenCalledWith("org-1", [sessionId]);
    expect(result?.sessionsTab).toHaveLength(1);
    expect(result?.sessionsTab[0]).toMatchObject({ id: sessionId });
  });

  it("rolls up child usage into a plugin detail's invocations/sessions/sessionsTab by pack_id (soul review HIGH + MEDIUM)", async () => {
    // Plugin inventory row with packId="rtk" and NO own usage rows. Its detail
    // invocations/sessions/sessionsTab must be derived from CHILD usage rolled
    // up by pack_id — matching the list view and the desktop reader.
    const pluginDetailRow = {
      id: "ac-plugin-rtk",
      computeTargetId: "target-1",
      componentKind: "plugin",
      componentKey: "rtk",
      externalComponentId: "plugin::rtk",
      harness: "claude",
      name: "RTK",
      sourceUrl: null,
      installPath: null,
      packId: "rtk",
      scope: null,
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      // Plugins are never invoked directly — no own usage rows.
      sessionUsages: [],
    };

    // Child usage rows (returned only for the packId-relation rollup query).
    const childUsage = [
      { agentSessionId: "sess-a", invocationCount: 4 },
      { agentSessionId: "sess-b", invocationCount: 1 },
    ];
    const usageFindMany = vi
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        if (where.agentComponent) {
          return Promise.resolve(childUsage);
        }
        return Promise.resolve([]);
      });

    mocks.listByArtifactIds.mockResolvedValue([
      { id: "sess-a" },
      { id: "sess-b" },
    ]);

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([pluginDetailRow]),
      },
      agentComponentSessionUsage: {
        findMany: usageFindMany,
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "plugin::rtk"
    );

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("plugin");
    // 4 + 1 child invocations rolled up (NOT the plugin's empty own usage).
    expect(result?.invocations).toBe(5);
    expect(result?.sessions).toBe(2);
    // sessionsTab is no longer hardcoded []: it lists the child-usage sessions.
    expect(mocks.listByArtifactIds).toHaveBeenCalledWith("org-1", [
      "sess-a",
      "sess-b",
    ]);
    expect(result?.sessionsTab).toHaveLength(2);
  });

  it("resolves an orphan-only (used-but-not-inventoried) component to a synthetic detail instead of 404 (#2613)", async () => {
    const sessionId = "session-orphan-only";
    // No inventory rows for this identity...
    // ...but usage rows exist (agentComponentId IS NULL). Previously this 404ed
    // even though the list surfaces the component via the orphan-usage fold.
    mocks.listByArtifactIds.mockResolvedValue([{ id: sessionId }]);

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          {
            agentSessionId: sessionId,
            invocationCount: 9,
            // Orphan usage recorded against codex — the synthetic detail must
            // reflect the actual row harness, NOT a hardcoded "claude".
            harness: "codex",
          },
        ]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::used-only-skill"
    );

    // Must NOT 404 — a synthetic detail is built from orphan usage.
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("skill");
    // id must be built via the encodeComponentSlug SSOT (FEA-3204), not an
    // inline `${kind}::${key}` literal that could drift from the codec.
    expect(result?.id).toBe(
      encodeComponentSlug("skill", "used-only-skill", null)
    );
    // Harness is derived from the usage row (codex), not hardcoded claude.
    expect(result?.harness).toBe("codex");
    expect(result?.invocations).toBe(9);
    expect(result?.sessions).toBe(1);
    expect(result?.usageSessions).toHaveLength(1);
    expect(result?.usageSessions[0]).toMatchObject({
      sessionId,
      invocationCount: 9,
    });
    // sessionsTab still populated from the reused session service.
    expect(mocks.listByArtifactIds).toHaveBeenCalledWith("org-1", [sessionId]);
    expect(result?.sessionsTab).toHaveLength(1);
    // No inventory row => no compute targets / provenance.
    expect(result?.provenance).toHaveLength(0);
    expect(result?.computeTargetIds).toHaveLength(0);
  });

  it("derives harness='both' for an orphan-only detail when usage rows disagree", async () => {
    const sessionA = "session-orphan-claude";
    const sessionB = "session-orphan-codex";
    mocks.listByArtifactIds.mockResolvedValue([
      { id: sessionA },
      { id: sessionB },
    ]);

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          { agentSessionId: sessionA, invocationCount: 2, harness: "claude" },
          { agentSessionId: sessionB, invocationCount: 3, harness: "codex" },
        ]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::mixed-harness-skill"
    );

    expect(result).not.toBeNull();
    // Conflicting harnesses across rows collapse to "both".
    expect(result?.harness).toBe("both");
  });

  it("falls back to harness='claude' for an orphan-only detail when rows leave harness unset", async () => {
    const sessionId = "session-orphan-null-harness";
    mocks.listByArtifactIds.mockResolvedValue([{ id: sessionId }]);

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentComponentSessionUsage: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { agentSessionId: sessionId, invocationCount: 4, harness: null },
          ]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::null-harness-skill"
    );

    expect(result).not.toBeNull();
    expect(result?.harness).toBe("claude");
  });

  it("still 404s when there are neither inventory rows nor orphan usage", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "skill::truly-missing"
    );

    expect(result).toBeNull();
  });

  it("returns usage=0 and empty tabs for a config-kind component (honest zero, no AgentSessionEvent fabrication)", async () => {
    const configRow = {
      id: "ac-config-1",
      computeTargetId: "target-1",
      componentKind: "config",
      componentKey: "settings-json",
      externalComponentId: "config::settings-json",
      harness: "claude",
      name: "settings.json",
      sourceUrl: null,
      installPath: null,
      scope: "user",
      projectPath: null,
      description: null,
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-10"),
      computeTarget: buildComputeTarget("target-1", "user-1"),
      sessionUsages: [], // config kinds are not materialized into usage
    };

    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([configRow]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await agentComponentsService.getDetailForOrg(
      "org-1",
      "config::settings-json"
    );

    expect(result).not.toBeNull();
    expect(result?.invocations).toBe(0);
    expect(result?.sessions).toBe(0);
    expect(result?.usageSessions).toHaveLength(0);
    expect(result?.sessionsTab).toHaveLength(0);
    // No session ids to forward => the session service is never queried.
    expect(mocks.listByArtifactIds).not.toHaveBeenCalled();
  });
});

describe("getPackAnalytics", () => {
  const OWNER = {
    id: "user-1",
    firstName: "Alice",
    lastName: "Ng",
    email: "alice@example.com",
  };

  it("aggregates child usage + owners/devices for a pack", async () => {
    installDb({
      // child usage rows consumed by loadChildUsageByPackId
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          {
            agentSessionId: "s1",
            invocationCount: 5,
            agentComponent: { packId: "pack-1" },
          },
          {
            agentSessionId: "s2",
            invocationCount: 3,
            agentComponent: { packId: "pack-1" },
          },
        ]),
      },
      // two inventory rows for the SAME owner across two devices
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          { computeTargetId: "device-1", computeTarget: { user: OWNER } },
          { computeTargetId: "device-2", computeTarget: { user: OWNER } },
        ]),
      },
    });

    const result = await agentComponentsService.getPackAnalytics(
      "org-1",
      "pack-1"
    );

    expect(result).toEqual({
      packId: "pack-1",
      invocations: 8, // 5 + 3
      sessions: 2, // s1, s2 deduped
      klocPerDollar: null, // no sessionDetail loc/cost rows
      owners: ["Alice Ng"], // deduped by user id across the two devices
      deviceCount: 2,
    });
  });

  it("returns null when the pack has no usage and no inventory", async () => {
    installDb({
      agentComponentSessionUsage: { findMany: vi.fn().mockResolvedValue([]) },
      agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await agentComponentsService.getPackAnalytics(
      "org-1",
      "pack-missing"
    );

    expect(result).toBeNull();
  });

  it("falls back to email when the owner has no name", async () => {
    installDb({
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([
          {
            agentSessionId: "s1",
            invocationCount: 1,
            agentComponent: { packId: "pack-1" },
          },
        ]),
      },
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          {
            computeTargetId: "device-1",
            computeTarget: {
              user: {
                id: "user-2",
                firstName: null,
                lastName: null,
                email: "noname@example.com",
              },
            },
          },
        ]),
      },
    });

    const result = await agentComponentsService.getPackAnalytics(
      "org-1",
      "pack-1"
    );

    expect(result?.owners).toEqual(["noname@example.com"]);
  });
});
