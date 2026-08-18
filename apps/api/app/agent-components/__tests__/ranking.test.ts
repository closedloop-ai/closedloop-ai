/**
 * Unit tests for rankingService (T-18.4, AC-018, AC-025).
 *
 * Prisma is mocked: withDb runs the callback against a fake client whose
 * delegates return fixtures (see `./org-population-fixtures`). Since ISS-4635
 * the leaderboard is built from the SHARED `buildOrgComponentPopulation`
 * pipeline the catalog list uses; the list/ranking parity and orphan-usage
 * regressions live in `./ranking-list-parity.test.ts`. Tests here assert:
 *   - org-scoping (every usage read is scoped to the calling org)
 *   - aggregation across compute targets (two devices → merged row)
 *   - stack-rank ordering (higher invocations = rank 1)
 *   - kind filter respected
 *   - components with zero invocations still appear (real data, not missing)
 *   - the inventory read stays bounded (deterministic order + row cap)
 *   - sessions are counted DISTINCT, unioned across rows folding to one identity
 */

import { AGENT_COMPONENT_INVENTORY_CAP } from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @repo/database BEFORE importing the service under test
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  // ISS-4669: `buildOrgComponentPopulation` reads FK-linked + orphan usage in one
  // `withDb.tx({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })`
  // snapshot, so the mocked module must expose that enum value.
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

// The ranking service's shared population module transitively pulls the heavy
// agent-sessions read service. Stub it so these tests stay isolated —
// getRanking never calls it. Mirrors `service.test.ts`.
vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: vi.fn().mockResolvedValue([]) },
}));

import { MAX_ORG_POPULATION_ROWS } from "../org-population-reads";
import { rankingService } from "../ranking/service";
import {
  buildPopulationDb,
  makeChildUsageRow,
  makeInventoryRow,
  makeOrphanUsage,
  makeRollup,
  ORG_A,
  type PopulationDb,
  type PopulationFixtures,
  TARGET_1,
  TARGET_2,
  TARGET_3,
} from "./org-population-fixtures";
import {
  orphanGroupByCalls,
  USAGE_WITHOUT_LIVE_INVENTORY_WHERE,
} from "./usage-lane-doubles";

/** Wire the shared fake Prisma client into this suite's hoisted `withDb` mock. */
function installDb(fixtures: PopulationFixtures): PopulationDb {
  const built = buildPopulationDb(fixtures);
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  return built;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rankingService.getRanking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty ranking when no inventory rows exist", async () => {
    const { groupBy } = installDb({ inventory: [], rollups: [] });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
    // No inventory ids to join → the FK usage rollup query is skipped entirely.
    // The ORPHAN lane still probes (an org can have usage-only components with
    // no inventory row at all), but its empty identity spine short-circuits the
    // aggregate read — so exactly ONE call reaches this delegate, and it is the
    // orphan spine, never the FK rollup.
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(orphanGroupByCalls({ groupBy })).toHaveLength(1);
  });

  it("stack-ranks components: higher invocations = rank 1", async () => {
    installDb({
      inventory: [
        makeInventoryRow({
          id: "c-code-review",
          componentKind: "command",
          componentKey: "code-review",
          name: "Code Review",
          computeTargetId: TARGET_1,
        }),
        makeInventoryRow({
          id: "c-lint-fix",
          componentKind: "command",
          componentKey: "lint-fix",
          name: "Lint Fix",
          computeTargetId: TARGET_1,
        }),
      ],
      // code-review: two sessions (5 + 3), lint-fix: one session (20).
      rollups: [
        makeRollup({
          agentComponentId: "c-code-review",
          invocationCount: 5,
          errorCount: 1,
        }),
        makeRollup({
          agentComponentId: "c-code-review",
          invocationCount: 3,
          errorCount: 0,
        }),
        makeRollup({
          agentComponentId: "c-lint-fix",
          invocationCount: 20,
          errorCount: 0,
        }),
      ],
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
    // The same "python-coach" command installed on TARGET_1 and TARGET_2 — two
    // distinct inventory rows (each its own agentComponentId) sharing one slug.
    installDb({
      inventory: [
        makeInventoryRow({
          id: "c-py-1",
          componentKind: "command",
          componentKey: "python-coach",
          name: "Python Coach",
          computeTargetId: TARGET_1,
        }),
        makeInventoryRow({
          id: "c-py-2",
          componentKind: "command",
          componentKey: "python-coach",
          name: "Python Coach",
          computeTargetId: TARGET_2,
        }),
      ],
      rollups: [
        makeRollup({
          agentComponentId: "c-py-1",
          invocationCount: 10,
          errorCount: 1,
        }),
        makeRollup({
          agentComponentId: "c-py-2",
          invocationCount: 7,
          errorCount: 0,
        }),
      ],
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
    expect(item?.sessions).toBe(2); // two distinct sessions across the two rows
    expect(item?.adoptionBreadth).toBe(2); // two distinct compute targets
    expect(item?.errorRate).toBeCloseTo(1 / 17);
  });

  it("org-scopes the FK usage read to the calling org", async () => {
    const { groupBy } = installDb({
      inventory: [
        makeInventoryRow({
          id: "c-test-runner",
          componentKind: "skill",
          componentKey: "test-runner",
          name: "Test Runner",
          computeTargetId: TARGET_1,
        }),
      ],
      // The DB filters other orgs' usage out via the where clause below, so the
      // rollup only carries the calling org's sums.
      rollups: [
        makeRollup({
          agentComponentId: "c-test-runner",
          invocationCount: 5,
          errorCount: 0,
        }),
      ],
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    // Org isolation is enforced in SQL: usage is scoped by session→artifact org
    // and bounded to the joined inventory ids.
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentComponentId: { in: ["c-test-runner"] },
          session: { artifact: { organizationId: ORG_A } },
        }),
      })
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.invocations).toBe(5);
    expect(result.items[0]?.sessions).toBe(1);
  });

  it("org-scopes the orphan usage read to the calling org", async () => {
    const { groupBy } = installDb({
      inventory: [
        makeInventoryRow({
          id: "c-test-runner",
          componentKind: "skill",
          componentKey: "test-runner",
          name: "Test Runner",
          computeTargetId: TARGET_1,
        }),
      ],
      // One orphan row so the lane's SECOND read (the aggregate, which the
      // empty-spine short-circuit would otherwise skip) actually fires and its
      // org scope can be asserted too.
      orphanUsage: [
        makeOrphanUsage({
          agentSessionId: "s-orphan-scope",
          componentKind: "skill",
          componentKey: "test-runner",
          invocationCount: 1,
        }),
      ],
    });

    await rankingService.getRanking({ organizationId: ORG_A, limit: 50 });

    // ISS-4799: the orphan lane reads through `groupBy` (spine + aggregate).
    // BOTH reads must carry the org scope — usage has no organizationId column
    // of its own, so the session→artifact relation is the only thing keeping a
    // foreign org's rows out.
    const orphanReads = orphanGroupByCalls({ groupBy });
    expect(orphanReads).toHaveLength(2);
    for (const read of orphanReads) {
      expect(read.where).toEqual(
        expect.objectContaining({
          // ISS-6180: usage no LIVE inventory row owns, carried under `AND` so
          // it cannot clobber the `?search=` facet's own `OR`.
          AND: [USAGE_WITHOUT_LIVE_INVENTORY_WHERE],
          session: { artifact: { organizationId: ORG_A } },
        })
      );
    }
  });

  it("ignores FK rollups that do not join to a capped inventory row", async () => {
    // A rollup with no matching inventory row (e.g. an inventory row dropped by
    // the cap, or usage whose component is uninstalled) must not be counted.
    //
    // `deliverUnjoinedRollups` makes the groupBy double hand the fold every
    // seeded rollup instead of pre-applying the query's `agentComponentId.in`
    // scope. Without it the fixture would drop `c-absent` and the null-FK group
    // before the code under test ran, and this test would still pass with both
    // production guards deleted.
    installDb({
      deliverUnjoinedRollups: true,
      inventory: [
        makeInventoryRow({
          id: "c-present",
          componentKind: "command",
          componentKey: "present",
          name: "Present",
          computeTargetId: TARGET_1,
        }),
      ],
      rollups: [
        makeRollup({
          agentComponentId: "c-present",
          invocationCount: 4,
          errorCount: 0,
        }),
        // No inventory row for this id, and the null group (unlinked usage —
        // read through the orphan lane instead, not this one).
        makeRollup({
          agentComponentId: "c-absent",
          invocationCount: 999,
          errorCount: 99,
        }),
        makeRollup({
          agentComponentId: null,
          invocationCount: 111,
          errorCount: 11,
        }),
      ],
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.invocations).toBe(4);
    expect(result.items[0]?.sessions).toBe(1);
  });

  it("sums errors across a multi-version family so errorRate shares its invocation denominator", async () => {
    // ISS-4635: `foldVersionIntoFamily` folds `totalErrors` alongside
    // `totalInvocations` when collapsing version buckets into one canonical
    // family. Without that fold the family keeps only the representative
    // bucket's errors while reporting the SUMMED invocations, so `errorRate`
    // silently divides one version's numerator by the whole family's
    // denominator. Two content versions of one component, each carrying errors,
    // are the smallest case that drives it.
    installDb({
      inventory: [
        makeInventoryRow({
          id: "c-v1",
          componentKind: "skill",
          componentKey: "flaky-skill",
          name: "Flaky Skill",
          computeTargetId: TARGET_1,
          contentHash: "hash-v1",
        }),
        makeInventoryRow({
          id: "c-v2",
          componentKind: "skill",
          componentKey: "flaky-skill",
          name: "Flaky Skill",
          computeTargetId: TARGET_2,
          contentHash: "hash-v2",
        }),
      ],
      rollups: [
        makeRollup({
          agentComponentId: "c-v1",
          invocationCount: 6,
          errorCount: 2,
          componentVersionHash: "hash-v1",
        }),
        makeRollup({
          agentComponentId: "c-v2",
          invocationCount: 4,
          errorCount: 1,
          componentVersionHash: "hash-v2",
        }),
      ],
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    // Both version buckets collapse into ONE leaderboard row.
    expect(result.items).toHaveLength(1);
    const [row] = result.items;
    // Invocations sum across versions (6+4) — the errorRate denominator.
    expect(row?.invocations).toBe(10);
    // Errors must sum across the SAME versions (2+1). If only the
    // representative bucket's errors survived, this would read 2/10 or 1/10.
    expect(row?.errorRate).toBeCloseTo(3 / 10);
  });

  it("filters by kind when kind param is supplied", async () => {
    const { findMany } = installDb({
      inventory: [
        makeInventoryRow({
          id: "c-skill",
          componentKind: "skill",
          componentKey: "my-skill",
          name: "My Skill",
          computeTargetId: TARGET_1,
        }),
      ],
      rollups: [],
    });

    await rankingService.getRanking({
      organizationId: ORG_A,
      kind: "skill",
      limit: 50,
    });

    // The endpoint's single-kind facet maps onto the shared population's
    // multi-kind one, so both surfaces emit the identical predicate.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ componentKind: { in: ["skill"] } }),
      })
    );
  });

  it("respects the limit parameter", async () => {
    const inventory = Array.from({ length: 10 }, (_, i) =>
      makeInventoryRow({
        id: `c-${i}`,
        componentKind: "command",
        componentKey: `cmd-${i}`,
        name: `Command ${i}`,
        computeTargetId: TARGET_1,
      })
    );
    const rollups = Array.from({ length: 10 }, (_, i) =>
      makeRollup({
        agentComponentId: `c-${i}`,
        invocationCount: 10 - i,
        errorCount: 0,
      })
    );

    installDb({ inventory, rollups });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 3,
    });

    expect(result.total).toBe(10); // total reflects all deduplicated entries
    expect(result.items).toHaveLength(3); // items are sliced to limit
  });

  it("components with zero invocations appear in ranking with errorRate=null", async () => {
    // Installed but never invoked — inventory row present, no matching usage.
    installDb({
      inventory: [
        makeInventoryRow({
          id: "c-rtk",
          componentKind: "plugin",
          componentKey: "rtk",
          name: "RTK",
          computeTargetId: TARGET_1,
        }),
      ],
      rollups: [],
      // Plugin usage rolls up from child rows by pack_id; this plugin has no
      // children (no childUsage fixture), so the rollup keeps it at zero.
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

  it("rolls up child usage into plugin entries by pack_id (FEA-3387)", async () => {
    // A plugin has NO own usage rows — its invocations/sessions come from its
    // child skill/command/subagent/mcp rows, matched by pack_id. Without the
    // rollup the plugin would rank last with invocations=0/sessions=0.
    const { usageFindMany } = installDb({
      inventory: [
        makeInventoryRow({
          id: "c-rtk",
          componentKind: "plugin",
          componentKey: "rtk",
          name: "RTK Plugin",
          computeTargetId: TARGET_1,
          packId: "rtk", // plugins never carry own usage rows
        }),
        makeInventoryRow({
          id: "c-lint-fix",
          componentKind: "command",
          componentKey: "lint-fix",
          name: "Lint Fix",
          computeTargetId: TARGET_1,
        }),
        // FEA-4337: the plugin's child inventory row — a `git-status` command
        // BELONGING to the rtk plugin (packId "rtk"). Its usage rows have no FK
        // link, so attribution must come from THIS row's (kind, key) → packId.
        makeInventoryRow({
          id: "c-git-status",
          componentKind: "command",
          componentKey: "git-status",
          name: "Git Status",
          computeTargetId: TARGET_1,
          packId: "rtk",
        }),
      ],
      // The command's own usage (FK-linked rollup).
      rollups: [
        makeRollup({ agentComponentId: "c-lint-fix", invocationCount: 10 }),
      ],
      // The plugin's usage comes only from its children, matched by the child
      // inventory identity (kind, key) → packId — NOT the usage row's FK.
      childUsage: [
        makeChildUsageRow({
          agentSessionId: "session-1",
          componentKey: "git-status",
          invocationCount: 12,
        }),
        makeChildUsageRow({
          agentSessionId: "session-2",
          componentKey: "git-status",
          invocationCount: 8,
        }),
        // Same session as a prior child usage row → the session must count once.
        makeChildUsageRow({
          agentSessionId: "session-1",
          componentKey: "git-status",
          invocationCount: 5,
        }),
      ],
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    // The child rollup query is scoped to this org and the invocation-carrying
    // child kinds, and does NOT depend on the usage row's `agentComponent` FK.
    expect(usageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          componentKind: { in: ["skill", "command", "subagent", "mcp"] },
          session: { artifact: { organizationId: ORG_A } },
        }),
      })
    );
    const childUsageCall = usageFindMany.mock.calls.find(
      (call) => whereOf(call)?.componentKind !== undefined
    );
    expect(whereOf(childUsageCall)?.agentComponent).toBeUndefined();

    const plugin = result.items.find((i) => i.kind === "plugin");
    expect(plugin?.invocations).toBe(25); // 12 + 8 + 5
    expect(plugin?.sessions).toBe(2); // session-1 (twice) + session-2 → 2
    // Plugin (25) now out-ranks the command (10) instead of ranking last at 0.
    expect(result.items[0]?.slug).toBe(plugin?.slug);
    expect(result.items[0]?.rank).toBe(1);
  });

  it("rolls up child errors into a plugin's errorRate (not a silent 0)", async () => {
    // A plugin has no own usage rows, so its errors must come from the child
    // rollup too. Before the rollup summed errors, errorRate was 0/invocations.
    installDb({
      inventory: [
        makeInventoryRow({
          id: "c-rtk",
          componentKind: "plugin",
          componentKey: "rtk",
          name: "RTK Plugin",
          computeTargetId: TARGET_1,
          packId: "rtk", // plugins never carry own usage rows
        }),
        // FEA-4337: the plugin's child inventory row that the orphan-FK child
        // usage attributes to via (kind, key) → packId.
        makeInventoryRow({
          id: "c-git-status",
          componentKind: "command",
          componentKey: "git-status",
          name: "Git Status",
          computeTargetId: TARGET_1,
          packId: "rtk",
        }),
      ],
      childUsage: [
        makeChildUsageRow({
          agentSessionId: "session-1",
          componentKey: "git-status",
          invocationCount: 10,
          errorCount: 2,
        }),
        makeChildUsageRow({
          agentSessionId: "session-2",
          componentKey: "git-status",
          invocationCount: 10,
          errorCount: 1,
        }),
      ],
    });

    const result = await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    const plugin = result.items.find((i) => i.kind === "plugin");
    expect(plugin?.invocations).toBe(20); // 10 + 10
    // 3 rolled-up child errors over 20 rolled-up invocations, not 0.
    expect(plugin?.errorRate).toBeCloseTo(3 / 20);
  });

  it("passes correct org-scoping where clause to the inventory read", async () => {
    const { findMany } = installDb({ inventory: [], rollups: [] });

    await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_A,
          // FEA-4086: tombstoned (uninstalled) rows never enter the population.
          uninstalledAt: null,
        }),
      })
    );
  });

  it("bounds the inventory read with a deterministic order and an identity cap", async () => {
    const { findMany, inventoryGroupBy } = installDb({
      inventory: [],
      rollups: [],
    });

    await rankingService.getRanking({
      organizationId: ORG_A,
      limit: 50,
    });

    // FEA-3166: the in-memory dedupe/sort/paginate must never materialize an
    // unbounded org inventory. ISS-4797 moved that bound from a raw-row `take`
    // — which made a stricter facet return MORE data — onto the DISTINCT
    // identity spine, still recency-ordered so the dropped tail is stable.
    expect(inventoryGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["componentKind", "componentKey"],
        orderBy: [
          { _max: { lastSeenAt: "desc" } },
          { componentKind: "asc" },
          { componentKey: "asc" },
        ],
        take: AGENT_COMPONENT_INVENTORY_CAP,
      })
    );
    // The row read that follows is bounded by the spine in the correctness
    // dimension, and carries `MAX_ORG_POPULATION_ROWS` only as a MEMORY ceiling —
    // set far above what the identity cap can legitimately expand to, so it
    // cannot reintroduce facet-dependent truncation. `nulls: "last"` is expressed
    // here (a plain scalar column accepts the order object that a `_max`
    // aggregate key does not) so a never-stamped row cannot displace a recent one
    // if the ceiling ever binds.
    const rowArgs = findMany.mock.calls[0]?.[0];
    expect(rowArgs?.orderBy).toEqual([
      { lastSeenAt: { sort: "desc", nulls: "last" } },
      { id: "asc" },
    ]);
    expect(rowArgs?.take).toBe(MAX_ORG_POPULATION_ROWS);
  });

  it("multiple components of the same kind are ranked in descending invocation order", async () => {
    installDb({
      inventory: [
        makeInventoryRow({
          id: "c-alpha",
          componentKind: "command",
          componentKey: "alpha",
          name: "Alpha",
          computeTargetId: TARGET_1,
        }),
        makeInventoryRow({
          id: "c-gamma",
          componentKind: "command",
          componentKey: "gamma",
          name: "Gamma",
          computeTargetId: TARGET_1,
        }),
        makeInventoryRow({
          id: "c-beta",
          componentKind: "command",
          componentKey: "beta",
          name: "Beta",
          computeTargetId: TARGET_1,
        }),
      ],
      rollups: [
        makeRollup({
          agentComponentId: "c-alpha",
          invocationCount: 3,
        }),
        makeRollup({
          agentComponentId: "c-gamma",
          invocationCount: 9,
        }),
        makeRollup({
          agentComponentId: "c-beta",
          invocationCount: 6,
        }),
      ],
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
      inventory: [
        makeInventoryRow({
          id: "c-mcp-1",
          componentKind: "mcp",
          componentKey: "gh-mcp",
          name: "GitHub MCP",
          computeTargetId: TARGET_1,
        }),
        makeInventoryRow({
          id: "c-mcp-2",
          componentKind: "mcp",
          componentKey: "gh-mcp",
          name: "GitHub MCP",
          computeTargetId: TARGET_2,
        }),
        makeInventoryRow({
          id: "c-mcp-3",
          componentKind: "mcp",
          componentKey: "gh-mcp",
          name: "GitHub MCP",
          computeTargetId: TARGET_3,
        }),
      ],
      rollups: [
        makeRollup({
          agentComponentId: "c-mcp-1",
          invocationCount: 2,
        }),
        makeRollup({
          agentComponentId: "c-mcp-2",
          invocationCount: 4,
        }),
        // c-mcp-3 installed but no sessions → no rollup
      ],
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
      inventory: [
        makeInventoryRow({
          id: "c-no-name",
          componentKind: "skill",
          componentKey: "no-name-skill",
          name: undefined, // no name field — falls back to componentKey
          computeTargetId: TARGET_1,
        }),
      ],
      rollups: [],
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
      inventory: [
        makeInventoryRow({
          id: "c-my-command",
          componentKind: "command",
          componentKey: "My Command",
          name: "My Command",
          computeTargetId: TARGET_1,
        }),
      ],
      rollups: [],
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
      // Single inventory row whose grouped rollup spans three distinct sessions.
      installDb({
        inventory: [
          makeInventoryRow({
            id: "c-build",
            componentKind: "command",
            componentKey: "build",
            name: "Build",
            computeTargetId: TARGET_1,
          }),
        ],
        rollups: [
          makeRollup({
            agentComponentId: "c-build",
            invocationCount: 5,
            errorCount: 1,
          }),
          makeRollup({
            agentComponentId: "c-build",
            invocationCount: 3,
            errorCount: 0,
          }),
          makeRollup({
            agentComponentId: "c-build",
            invocationCount: 7,
            errorCount: 2,
          }),
        ],
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

    it("counts DISTINCT sessions, not usage rows (FEA-3386)", async () => {
      // The DB groups by (component, session, …), so a session's per-branch
      // usage rows arrive pre-folded: session s-1's 5 + 3 = 8 comes as a single
      // group, plus s-2's 7. `sessions` is the count of distinct session ids.
      installDb({
        inventory: [
          makeInventoryRow({
            id: "c-build",
            componentKind: "command",
            componentKey: "build",
            name: "Build",
            computeTargetId: TARGET_1,
          }),
        ],
        rollups: [
          makeRollup({
            agentComponentId: "c-build",
            sessionId: "s-1",
            invocationCount: 8, // 5 + 3, folded across branches by the DB
            errorCount: 0,
          }),
          makeRollup({
            agentComponentId: "c-build",
            sessionId: "s-2",
            invocationCount: 7,
            errorCount: 0,
          }),
        ],
      });

      const result = await rankingService.getRanking({
        organizationId: ORG_A,
        limit: 50,
      });

      const item = result.items[0];
      // totalInvocations (SUM) stays additive; sessions is the DISTINCT count.
      expect(item?.invocations).toBe(15); // 8 + 7
      expect(item?.sessions).toBe(2); // s-1 + s-2 → 2 distinct
    });

    it("does not double-count a session shared across inventory rows folding into one identity (FEA-3386)", async () => {
      // Two inventory rows whose keys normalize to the same org identity, each
      // carrying a rollup for the SAME session. Summed row counting would report
      // 2 sessions; the distinct-set union across the folded rows reports 1.
      installDb({
        inventory: [
          makeInventoryRow({
            id: "c-deploy-1",
            componentKind: "command",
            componentKey: "Deploy",
            name: "Deploy",
            computeTargetId: TARGET_1,
          }),
          makeInventoryRow({
            id: "c-deploy-2",
            componentKind: "command",
            componentKey: "deploy ", // trailing space → same normalized identity
            name: "Deploy",
            computeTargetId: TARGET_2,
          }),
        ],
        rollups: [
          makeRollup({
            agentComponentId: "c-deploy-1",
            sessionId: "shared",
            invocationCount: 4,
            errorCount: 0,
          }),
          makeRollup({
            agentComponentId: "c-deploy-2",
            sessionId: "shared",
            invocationCount: 6,
            errorCount: 0,
          }),
        ],
      });

      const result = await rankingService.getRanking({
        organizationId: ORG_A,
        limit: 50,
      });

      expect(result.total).toBe(1); // folded to one identity
      const item = result.items[0];
      expect(item?.invocations).toBe(10); // 4 + 6, SUM stays additive
      expect(item?.sessions).toBe(1); // one distinct session across both rows
    });
  });

  describe("session isolation across orgs", () => {
    it("usage rows from a different org do not inflate the calling org's ranking", async () => {
      // Isolation is enforced in SQL: the groupBy where clause scopes usage to
      // the calling org, so the rollup already excludes other orgs' sums.
      const { groupBy } = installDb({
        inventory: [
          makeInventoryRow({
            id: "c-shared",
            componentKind: "skill",
            componentKey: "shared-skill",
            name: "Shared Skill",
            computeTargetId: TARGET_1,
          }),
        ],
        rollups: [
          makeRollup({
            agentComponentId: "c-shared",
            invocationCount: 10,
            errorCount: 0,
          }),
        ],
      });

      const result = await rankingService.getRanking({
        organizationId: ORG_A,
        limit: 50,
      });

      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            session: { artifact: { organizationId: ORG_A } },
          }),
        })
      );
      expect(result.items[0]?.invocations).toBe(10);
    });
  });
});

/** The `where` clause of a recorded Prisma delegate call, if any. */
function whereOf(
  call: readonly unknown[] | undefined
): Record<string, unknown> | undefined {
  const args = call?.[0] as { where?: Record<string, unknown> } | undefined;
  return args?.where;
}
