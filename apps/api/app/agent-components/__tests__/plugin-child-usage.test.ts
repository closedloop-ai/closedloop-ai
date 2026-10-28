/**
 * Unit tests for the plugin child-usage rollup (`plugin-child-usage.ts`,
 * FEA-4337). A plugin has NO own usage rows — its invocations/sessions are the
 * SUM of its CHILD (skill/command/subagent/mcp) usage, attributed by the child
 * INVENTORY identity `(componentKind, componentKey)` → packId, NOT the usage
 * row's nullable `agentComponentId` FK. These tests drive the real aggregation
 * against a filter-aware fake `db` and assert the orphan-FK recovery that the old
 * FK-based rollup dropped (folding every plugin to zero).
 */

import {
  AgentComponentKind,
  PLUGIN_CHILD_KINDS,
} from "@repo/api/src/types/agent-component";
import { normalizeComponentKey } from "@repo/api/src/types/agent-component-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitPackIdentity,
  loadChildUsageByPackId,
  loadPluginChildUsage,
  pluginPackCandidates,
  sumPluginChildUsage,
  usageWithoutTombstonedInventoryWhere,
} from "../plugin-child-usage";

const ORG = "org-1";

/**
 * The row ceiling this lane carried before ISS-6891, restated here rather than
 * imported: the production constant now bounds only the DETAIL reads, so
 * importing it would tie this fixture to a value that no longer governs the code
 * under test. Sized to fill the former cap on its own.
 */
const FORMER_CHILD_USAGE_CAP = 20_000;

type ChildInvRow = {
  id?: string;
  componentKind: string;
  componentKey: string | null;
  packId: string | null;
  /** ISS-6180: a tombstoned (uninstalled) child — must not join the rollup. */
  uninstalledAt?: Date | null;
};

type ChildUsageRow = {
  id?: string;
  agentSessionId: string;
  agentComponentId?: string | null;
  componentKind: string;
  componentKey: string;
  invocationCount: number;
  errorCount: number;
  lastInvokedAt: Date | null;
};

type UsageIdentityOr = {
  componentKind: string;
  componentKeyNormalized: string;
};

type UsageComponentIdOr = {
  agentComponentId: { in: string[] };
};

type UsageOr = Array<UsageIdentityOr | UsageComponentIdOr>;

/**
 * ISS-6180: the `AND`-nested lane-membership arms
 * `usageWithoutTombstonedInventoryWhere()` emits — a null FK, or a FK whose
 * TARGET row is live.
 */
type UsageAnd = Array<{
  OR?: Array<{
    agentComponentId?: null;
    agentComponent?: { uninstalledAt: Date | null };
  }>;
}>;

/**
 * ISS-6180 (davetho review): evaluate one arm of the child lane's
 * tombstoned-FK exclusion against a usage row, resolving the `agentComponent`
 * relation from the FIXTURE'S OWN inventory.
 *
 * Modelled rather than waved through: this arm is the entire fix, and a double
 * that ignored it would hand the tombstoned row to the old code as well, leaving
 * the regression green against the bug. Prisma's to-one relation filter is
 * `is`-shaped, so a NULL relation matches no nested predicate — which is what
 * keeps the null-FK arm and the live-FK arm from collapsing into each other.
 */
function matchesFkLivenessArm(
  row: ChildUsageRow,
  arm: {
    agentComponentId?: null;
    agentComponent?: { uninstalledAt: Date | null };
  },
  inventoryById: Map<string, ChildInvRow>
): boolean {
  if ("agentComponentId" in arm) {
    return (row.agentComponentId ?? null) === null;
  }
  if (arm.agentComponent) {
    const target = row.agentComponentId
      ? inventoryById.get(row.agentComponentId)
      : undefined;
    return target !== undefined && (target.uninstalledAt ?? null) === null;
  }
  throw new Error(`double does not model usage AND arm ${JSON.stringify(arm)}`);
}

/**
 * Honor the production usage read's `OR` identity prefilter (an equality on the
 * persisted `componentKeyNormalized` fold), its `AND`-nested tombstoned-FK
 * exclusion (ISS-6180), `orderBy` (lastInvokedAt desc, nulls last, then id asc),
 * and `take` cap so a test can prove the cap drops the LEAST-recent MATCHED rows
 * — not that unrelated org rows fill the cap ahead of a target row (whitlockk
 * review).
 *
 * The fold is DERIVED here from each fixture row's `componentKey`, never read off
 * a field the fixture sets, because that is what the ISS-6756 BEFORE
 * INSERT/UPDATE trigger does to the real column. A double that let a fixture
 * supply its own fold could seed a row whose stored value disagrees with its key
 * — a state the trigger makes unreachable — and the case/whitespace-parity case
 * below would then pass on the fixture rather than on the fold.
 */
function applyUsageQuery(
  rows: ChildUsageRow[],
  inventoryById: Map<string, ChildInvRow>,
  args?: {
    where?: { OR?: UsageOr; AND?: UsageAnd };
    take?: number;
  }
): ChildUsageRow[] {
  const or = args?.where?.OR;
  let matched = rows;
  if (or) {
    matched = rows.filter((r) =>
      or.some((o) => {
        if ("agentComponentId" in o) {
          return o.agentComponentId.in.includes(r.agentComponentId ?? "");
        }
        return (
          o.componentKind === r.componentKind &&
          normalizeComponentKey(r.componentKey) === o.componentKeyNormalized
        );
      })
    );
  }
  for (const clause of args?.where?.AND ?? []) {
    const arms = clause.OR ?? [];
    matched = matched.filter((r) =>
      arms.some((arm) => matchesFkLivenessArm(r, arm, inventoryById))
    );
  }
  const ordered = [...matched].sort((a, b) => {
    const at = a.lastInvokedAt?.getTime() ?? -1;
    const bt = b.lastInvokedAt?.getTime() ?? -1;
    if (at !== bt) {
      return bt - at; // desc, nulls last
    }
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
  return typeof args?.take === "number" ? ordered.slice(0, args.take) : ordered;
}

/**
 * A fake Prisma client whose `agentComponent.findMany` returns the child
 * inventory rows (the child-identity read filters by `packId` + `componentKind`,
 * and — ISS-6180 — by `uninstalledAt: null`) and
 * `agentComponentSessionUsage.findMany` returns the child usage rows, applying
 * the production `OR`/`orderBy`/`take` semantics. Both reads are captured so a
 * test can assert their predicate shape.
 */
function makeDb(
  childInventory: ChildInvRow[],
  childUsage: ChildUsageRow[]
): {
  db: Record<string, unknown>;
  usageFindMany: ReturnType<typeof vi.fn>;
  inventoryFindMany: ReturnType<typeof vi.fn>;
} {
  const inventoryRows = childInventory.map((row, index) => ({
    ...row,
    id: row.id ?? `inventory-${index}`,
  }));
  const inventoryFindMany = vi.fn(
    (args?: {
      where?: { packId?: { in?: string[] }; uninstalledAt?: Date | null };
    }) => {
      const packFilter = args?.where?.packId?.in;
      let rows = packFilter
        ? inventoryRows.filter((r) => r.packId && packFilter.includes(r.packId))
        : inventoryRows;
      // Honor the live-inventory scope so a test can prove a tombstoned child is
      // dropped by the QUERY, not by application code downstream of it.
      if (args?.where && "uninstalledAt" in args.where) {
        rows = rows.filter(
          (r) => (r.uninstalledAt ?? null) === args.where?.uninstalledAt
        );
      }
      return Promise.resolve(rows);
    }
  );
  // Resolve each usage row's FK against the FULL fixture inventory (including
  // tombstoned rows, which the live-only inventory read above filters out), so
  // the relation predicate is evaluated against the row the FK really points at.
  const inventoryById = new Map(
    inventoryRows.map((row) => [row.id, row] as const)
  );
  // ISS-8932: the production read selects the row's primary key and de-duplicates
  // its sliced statements on it, so a fixture row that declares none is given a
  // STABLE synthetic one. Without it every id-less row would collapse onto the
  // same key and this double would report a rollup no database could produce.
  const usageWithIds = childUsage.map((row, index) => ({
    id: `child-usage-${index}`,
    ...row,
  }));
  const usageFindMany = vi.fn(
    (args?: { where?: { OR?: UsageOr; AND?: UsageAnd }; take?: number }) =>
      Promise.resolve(applyUsageQuery(usageWithIds, inventoryById, args))
  );
  const db = {
    agentComponent: { findMany: inventoryFindMany },
    agentComponentSessionUsage: { findMany: usageFindMany },
  };
  return { db, usageFindMany, inventoryFindMany };
}

/**
 * The prefilter the rollup actually asked SQL for, in emission order.
 *
 * ISS-8932 issues the FK lane and the identity lane as separate bound-sliced
 * statements, so the predicate a case is asserting is their union rather than one
 * call's `OR`. Reading every call also means an arm silently moved into a second
 * statement still has to be there — a per-call assertion would let one vanish.
 */
function emittedPrefilterArms(usageFindMany: ReturnType<typeof vi.fn>) {
  return usageFindMany.mock.calls.flatMap(
    (call) =>
      (call[0] as { where?: { OR?: UsageOr } } | undefined)?.where?.OR ?? []
  );
}

describe("loadChildUsageByPackId (FEA-4337)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attributes ORPHAN-FK child usage to a pack via the child inventory identity", async () => {
    // The child usage rows carry NO FK — only their natural (kind, key). The
    // matching child inventory row supplies the packId. The OLD FK-based rollup
    // dropped these entirely (plugin → 0); the natural-key join recovers them.
    const { db, usageFindMany } = makeDb(
      [{ componentKind: "command", componentKey: "git-status", packId: "rtk" }],
      [
        {
          agentSessionId: "s1",
          componentKind: "command",
          componentKey: "git-status",
          invocationCount: 3,
          errorCount: 1,
          lastInvokedAt: new Date("2026-02-01"),
        },
        {
          agentSessionId: "s2",
          componentKind: "command",
          componentKey: "git-status",
          invocationCount: 2,
          errorCount: 0,
          lastInvokedAt: new Date("2026-02-02"),
        },
      ]
    );

    const byPack = await loadChildUsageByPackId(db as never, ["rtk"], ORG);

    const bucket = byPack.get("rtk");
    expect(bucket?.invocations).toBe(5); // 3 + 2
    expect(bucket?.sessionIds.size).toBe(2); // s1, s2
    expect(bucket?.errors).toBe(1);
    expect(bucket?.lastInvokedAt).toEqual(new Date("2026-02-02"));

    // The usage read must NOT depend on the usage row's FK relation.
    const usageWhere = usageFindMany.mock.calls[0]?.[0]?.where;
    expect(usageWhere?.agentComponent).toBeUndefined();
    expect(usageWhere?.componentKind).toEqual({
      in: [...PLUGIN_CHILD_KINDS],
    });
  });

  it("matches child identity case/whitespace-insensitively (desktop parity)", async () => {
    // Inventory key `Reviewer`, usage key `reviewer ` — normalized both sides.
    const { db } = makeDb(
      [{ componentKind: "skill", componentKey: "Reviewer", packId: "pack-x" }],
      [
        {
          agentSessionId: "s1",
          componentKind: "skill",
          componentKey: "reviewer ",
          invocationCount: 4,
          errorCount: 0,
          lastInvokedAt: null,
        },
      ]
    );

    const byPack = await loadChildUsageByPackId(db as never, ["pack-x"], ORG);
    expect(byPack.get("pack-x")?.invocations).toBe(4);
  });

  it("keeps stable-FK usage written before an inventory key rename (whitlockk)", async () => {
    const { db, usageFindMany } = makeDb(
      [
        {
          id: "inv-reviewer",
          componentKind: AgentComponentKind.Skill,
          componentKey: "reviewer",
          packId: "pack-x",
        },
      ],
      [
        {
          agentSessionId: "s-before-rename",
          agentComponentId: "inv-reviewer",
          componentKind: AgentComponentKind.Skill,
          componentKey: "reviewer-extra",
          invocationCount: 6,
          errorCount: 1,
          lastInvokedAt: new Date("2026-08-01"),
        },
      ]
    );

    const byPack = await loadChildUsageByPackId(db as never, ["pack-x"], ORG);

    expect(byPack.get("pack-x")?.invocations).toBe(6);
    expect(byPack.get("pack-x")?.errors).toBe(1);
    expect(emittedPrefilterArms(usageFindMany)).toEqual([
      { agentComponentId: { in: ["inv-reviewer"] } },
      {
        componentKind: AgentComponentKind.Skill,
        componentKeyNormalized: "reviewer",
      },
    ]);
  });

  it("excludes a TOMBSTONED (uninstalled) child from the rollup (ISS-6180)", async () => {
    // Scanners tombstone rather than delete and nothing clears the child's
    // `packId`, so an uninstalled child's usage kept rolling into its plugin's
    // total while the same usage ALSO reappeared as a standalone orphan row —
    // one invocation counted twice in one response. The dead child's usage row
    // even carries an authoritative FK, so this covers BOTH attribution paths.
    const { db, usageFindMany, inventoryFindMany } = makeDb(
      [
        {
          id: "inv-live",
          componentKind: AgentComponentKind.Skill,
          componentKey: "gstack-nav",
          packId: "gstack",
          uninstalledAt: null,
        },
        {
          id: "inv-dead",
          componentKind: AgentComponentKind.Mcp,
          componentKey: "gstack-mcp",
          packId: "gstack",
          uninstalledAt: new Date("2026-07-01"),
        },
      ],
      [
        {
          agentSessionId: "s1",
          componentKind: AgentComponentKind.Skill,
          componentKey: "gstack-nav",
          invocationCount: 4,
          errorCount: 0,
          lastInvokedAt: new Date("2026-08-01"),
        },
        {
          agentSessionId: "s2",
          agentComponentId: "inv-dead",
          componentKind: AgentComponentKind.Mcp,
          componentKey: "gstack-mcp",
          invocationCount: 5,
          errorCount: 2,
          lastInvokedAt: new Date("2026-08-02"),
        },
      ]
    );

    const byPack = await loadChildUsageByPackId(db as never, ["gstack"], ORG);
    const bucket = byPack.get("gstack");
    // Only the LIVE child's 4 invocations — not 9 — and its session alone.
    expect(bucket?.invocations).toBe(4);
    expect(bucket?.errors).toBe(0);
    expect([...(bucket?.sessionIds ?? [])]).toEqual(["s1"]);
    expect(bucket?.lastInvokedAt).toEqual(new Date("2026-08-01"));

    // The scope is in the QUERY (the same `uninstalledAt: null` predicate
    // `orgInventoryWhere` applies), so the dead child never reaches the usage
    // read's identity prefilter either.
    const invWhere = inventoryFindMany.mock.calls[0]?.[0]?.where;
    expect(invWhere?.uninstalledAt).toBeNull();
    expect(emittedPrefilterArms(usageFindMany)).toEqual([
      { agentComponentId: { in: ["inv-live"] } },
      {
        componentKind: AgentComponentKind.Skill,
        componentKeyNormalized: "gstack-nav",
      },
    ]);
  });

  it("excludes a tombstoned child whose (kind, key) a LIVE sibling still carries (ISS-6180, davetho)", async () => {
    // The case scoping the inventory join to live children does NOT cover. The
    // live sibling keeps `skill::gstack-nav` in `packIdsByIdentity` and in the
    // SQL identity prefilter, so the DEAD row's usage is admitted by the
    // prefilter, its FK misses the live-only `packIdByComponentId`, and
    // `resolveUsagePackId` falls back to the LIVE sibling's identity — rolling
    // the tombstoned child's invocations into the plugin while the usage-only
    // lane ALSO emits them. Same identity is the whole point: the pre-existing
    // tombstone test uses a dead child with a DIFFERENT `(kind, key)`, which the
    // identity fallback never matches, so it passes either way.
    const { db, usageFindMany } = makeDb(
      [
        {
          id: "inv-live",
          componentKind: AgentComponentKind.Skill,
          componentKey: "gstack-nav",
          packId: "gstack",
          uninstalledAt: null,
        },
        {
          id: "inv-dead",
          componentKind: AgentComponentKind.Skill,
          componentKey: "gstack-nav",
          packId: "gstack",
          uninstalledAt: new Date("2026-07-01"),
        },
      ],
      [
        {
          id: "u-live",
          agentSessionId: "s-live",
          agentComponentId: "inv-live",
          componentKind: AgentComponentKind.Skill,
          componentKey: "gstack-nav",
          invocationCount: 4,
          errorCount: 0,
          lastInvokedAt: new Date("2026-08-01"),
        },
        {
          id: "u-dead",
          agentSessionId: "s-dead",
          agentComponentId: "inv-dead",
          componentKind: AgentComponentKind.Skill,
          componentKey: "gstack-nav",
          invocationCount: 5,
          errorCount: 2,
          lastInvokedAt: new Date("2026-08-02"),
        },
      ]
    );

    const byPack = await loadChildUsageByPackId(db as never, ["gstack"], ORG);
    const bucket = byPack.get("gstack");
    // 4, not 9: the dead row is excluded even though its identity resolves.
    expect(bucket?.invocations).toBe(4);
    expect(bucket?.errors).toBe(0);
    expect([...(bucket?.sessionIds ?? [])]).toEqual(["s-live"]);
    // `lastInvokedAt` follows too — the dead row is the more recent one, so a
    // leak would be visible here even if the totals happened to agree.
    expect(bucket?.lastInvokedAt).toEqual(new Date("2026-08-01"));

    // The exclusion is in the QUERY, and it is the SHARED predicate — asserted
    // against the exported helper so the two cannot drift apart.
    expect(usageFindMany.mock.calls[0]?.[0]?.where?.AND).toEqual([
      usageWithoutTombstonedInventoryWhere(),
    ]);
  });

  it("keeps a NULL-FK child row, so the natural-key fallback survives the tombstone exclusion (ISS-6180)", async () => {
    // The constraint that makes the fix narrow: excluding tombstoned-FK rows
    // must not also exclude UNLINKED ones. A null FK is the original FEA-4337
    // orphan case — usage that synced before its inventory row existed — and
    // collapsing the two would silently re-break every plugin whose child usage
    // the component-sync lane never linked.
    const { db } = makeDb(
      [
        {
          id: "inv-live",
          componentKind: AgentComponentKind.Skill,
          componentKey: "gstack-nav",
          packId: "gstack",
          uninstalledAt: null,
        },
      ],
      [
        {
          id: "u-unlinked",
          agentSessionId: "s-unlinked",
          agentComponentId: null,
          componentKind: AgentComponentKind.Skill,
          componentKey: "gstack-nav",
          invocationCount: 6,
          errorCount: 1,
          lastInvokedAt: new Date("2026-08-03"),
        },
      ]
    );

    const byPack = await loadChildUsageByPackId(db as never, ["gstack"], ORG);
    expect(byPack.get("gstack")?.invocations).toBe(6);
    expect(byPack.get("gstack")?.errors).toBe(1);
  });

  it("attributes an orphan-FK child under two packs to ONE pack, so the summed list rollup can't double-count (whitlockk)", async () => {
    // The same child (kind, key) belongs to two of the plugin's candidate packs.
    // Folding the usage row into BOTH buckets made `sumPluginChildUsage` add its
    // invocations twice. The row is now attributed to exactly one deterministic
    // pack (lexicographic min), so the summed rollup counts it once.
    const { db } = makeDb(
      [
        { componentKind: "command", componentKey: "shared", packId: "pack-b" },
        { componentKind: "command", componentKey: "shared", packId: "pack-a" },
      ],
      [
        {
          agentSessionId: "s1",
          agentComponentId: null,
          componentKind: "command",
          componentKey: "shared",
          invocationCount: 7,
          errorCount: 2,
          lastInvokedAt: null,
        },
      ]
    );

    const byPack = await loadChildUsageByPackId(
      db as never,
      ["pack-a", "pack-b"],
      ORG
    );
    // Attributed to the deterministic pick (pack-a), not both.
    expect(byPack.get("pack-a")?.invocations).toBe(7);
    expect(byPack.get("pack-b")).toBeUndefined();

    // The list/ranking rollup sums the plugin's candidate packs — it must total
    // the row ONCE, not 14/4.
    const rollup = sumPluginChildUsage(["pack-a", "pack-b"], byPack);
    expect(rollup.invocations).toBe(7);
    expect(rollup.errors).toBe(2);
    expect(rollup.sessionIds.size).toBe(1);
  });

  it("credits a usage row's authoritative agentComponentId FK to that inventory row's pack, not an org-global identity match (whitlockk)", async () => {
    // Two compute targets carry the same (kind, key) under DIFFERENT packs. The
    // usage row's FK points at compute-target-B's inventory row, so it must be
    // credited to pack-b — the exact pack the writer linked — even though the
    // identity also matches pack-a on the other compute target.
    const { db } = makeDb(
      [
        {
          id: "inv-a",
          componentKind: "skill",
          componentKey: "reviewer",
          packId: "pack-a",
        },
        {
          id: "inv-b",
          componentKind: "skill",
          componentKey: "reviewer",
          packId: "pack-b",
        },
      ],
      [
        {
          agentSessionId: "s1",
          agentComponentId: "inv-b",
          componentKind: "skill",
          componentKey: "reviewer",
          invocationCount: 5,
          errorCount: 0,
          lastInvokedAt: new Date("2026-03-01"),
        },
      ]
    );

    const byPack = await loadChildUsageByPackId(
      db as never,
      ["pack-a", "pack-b"],
      ORG
    );
    expect(byPack.get("pack-b")?.invocations).toBe(5);
    expect(byPack.get("pack-a")).toBeUndefined();
  });

  it("keeps the requested pack's usage even when it sorts BEYOND the MAX cap behind unrelated org activity (whitlockk)", async () => {
    // The requested pack's only child usage row is the OLDEST (last-invoked). A
    // flood of unrelated org child usage sits ahead of it by recency. Because the
    // identity prefilter runs in SQL BEFORE the cap, the unrelated rows never
    // enter the requested pack's read, so the target row survives.
    const targetRow: ChildUsageRow = {
      id: "z-target",
      agentSessionId: "s-target",
      agentComponentId: null,
      componentKind: "command",
      componentKey: "target-cmd",
      invocationCount: 11,
      errorCount: 0,
      lastInvokedAt: new Date("2020-01-01"), // oldest → last by recency
    };
    const noise: ChildUsageRow[] = Array.from({ length: 50 }, (_, i) => ({
      id: `noise-${i}`,
      agentSessionId: `noise-s-${i}`,
      agentComponentId: null,
      componentKind: "command",
      componentKey: "unrelated-cmd",
      invocationCount: 1,
      errorCount: 0,
      lastInvokedAt: new Date(2026, 0, i + 1),
    }));

    const { db, usageFindMany } = makeDb(
      [
        {
          componentKind: "command",
          componentKey: "target-cmd",
          packId: "target-pack",
        },
      ],
      [...noise, targetRow]
    );

    const byPack = await loadChildUsageByPackId(
      db as never,
      ["target-pack"],
      ORG
    );
    // The target row is recovered despite being least-recent org-wide.
    expect(byPack.get("target-pack")?.invocations).toBe(11);
    // Proof the prefilter is in SQL: the usage read carried the identity OR
    // (an equality on the persisted normalized child key).
    expect(emittedPrefilterArms(usageFindMany)).toEqual([
      { agentComponentId: { in: ["inventory-0"] } },
      {
        componentKind: "command",
        componentKeyNormalized: "target-cmd",
      },
    ]);
  });

  it("keeps a QUIET pack's usage when a busy sibling pack fills the read (ISS-6891)", async () => {
    // The residual truncation ISS-6891 removed from this lane. The list rollup
    // unions EVERY candidate pack across the population into one read, ordered by
    // recency globally — so the prefilter above (which only keeps unrelated org
    // activity out) does nothing here: both packs are inside the same prefiltered
    // read, and a busy pack's recent rows crowded a quiet pack's older row out of
    // the retained set. The quiet plugin then rolled up to zero, by an amount that
    // depended on which facet assembled the pack union.
    const quietRow: ChildUsageRow = {
      id: "z-quiet",
      agentSessionId: "s-quiet",
      agentComponentId: null,
      componentKind: "command",
      componentKey: "quiet-cmd",
      invocationCount: 7,
      errorCount: 0,
      lastInvokedAt: new Date("2020-01-01"), // older than every busy row
    };
    const busyRows: ChildUsageRow[] = Array.from(
      { length: FORMER_CHILD_USAGE_CAP },
      (_unused, index) => ({
        id: `busy-${index}`,
        agentSessionId: `busy-s-${index}`,
        agentComponentId: null,
        componentKind: "command",
        componentKey: "busy-cmd",
        invocationCount: 1,
        errorCount: 0,
        lastInvokedAt: new Date(2026, 0, 1, 0, 0, index),
      })
    );

    const { db } = makeDb(
      [
        {
          componentKind: "command",
          componentKey: "busy-cmd",
          packId: "busy-pack",
        },
        {
          componentKind: "command",
          componentKey: "quiet-cmd",
          packId: "quiet-pack",
        },
      ],
      [...busyRows, quietRow]
    );

    const byPack = await loadChildUsageByPackId(
      db as never,
      ["busy-pack", "quiet-pack"],
      ORG
    );

    // Pinned to independent literals. Under the former cap the quiet pack read
    // `undefined` here, while the busy pack reported its full total — a narrower
    // request (quiet-pack alone) would then have surfaced usage the wider one hid.
    expect(byPack.get("quiet-pack")?.invocations).toBe(7);
    expect(byPack.get("busy-pack")?.invocations).toBe(FORMER_CHILD_USAGE_CAP);
  });

  it("returns an empty map (no usage read) when no child inventory matches", async () => {
    const { db, usageFindMany } = makeDb(
      [],
      [
        {
          agentSessionId: "s1",
          componentKind: "command",
          componentKey: "git-status",
          invocationCount: 9,
          errorCount: 0,
          lastInvokedAt: null,
        },
      ]
    );

    const byPack = await loadChildUsageByPackId(db as never, ["rtk"], ORG);
    expect(byPack.size).toBe(0);
    // No child inventory ⇒ skip the usage read entirely.
    expect(usageFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty map for an empty packIds list", async () => {
    const { db, inventoryFindMany } = makeDb([], []);
    const byPack = await loadChildUsageByPackId(db as never, [], ORG);
    expect(byPack.size).toBe(0);
    expect(inventoryFindMany).not.toHaveBeenCalled();
  });
});

describe("loadPluginChildUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("unions candidate packs (packIds ∪ key) across plugins before loading", async () => {
    const { db, inventoryFindMany } = makeDb(
      [{ componentKind: "command", componentKey: "git-status", packId: "rtk" }],
      [
        {
          agentSessionId: "s1",
          componentKind: "command",
          componentKey: "git-status",
          invocationCount: 5,
          errorCount: 0,
          lastInvokedAt: null,
        },
      ]
    );

    const byPack = await loadPluginChildUsage(
      db as never,
      [{ packIds: new Set(["rtk"]), key: "rtk" }],
      ORG
    );
    expect(byPack.get("rtk")?.invocations).toBe(5);
    // The child-identity read is issued with the unioned candidate packs.
    const invWhere = inventoryFindMany.mock.calls[0]?.[0]?.where;
    expect(invWhere?.packId?.in).toContain("rtk");
  });

  it("returns an empty map when no plugin has a pack association", async () => {
    const { db } = makeDb([], []);
    const byPack = await loadPluginChildUsage(
      db as never,
      [{ packIds: new Set<string>(), key: null }],
      ORG
    );
    expect(byPack.size).toBe(0);
  });
});

describe("pluginPackCandidates / sumPluginChildUsage", () => {
  it("includes the plugin's own key alongside its folded pack ids", () => {
    const candidates = pluginPackCandidates({
      packIds: new Set(["p1", "p2"]),
      key: "rtk",
    });
    expect([...candidates].sort()).toEqual(["p1", "p2", "rtk"]);
  });

  it("unions sessions across candidate packs so a shared session counts once", () => {
    const byPack = new Map([
      [
        "p1",
        {
          invocations: 3,
          errors: 1,
          sessionIds: new Set(["s1", "s2"]),
          lastInvokedAt: new Date("2026-01-01"),
        },
      ],
      [
        "p2",
        {
          invocations: 4,
          errors: 0,
          sessionIds: new Set(["s2", "s3"]),
          lastInvokedAt: new Date("2026-01-05"),
        },
      ],
    ]);
    const rollup = sumPluginChildUsage(["p1", "p2"], byPack);
    expect(rollup.invocations).toBe(7);
    expect(rollup.errors).toBe(1);
    expect(rollup.sessionIds.size).toBe(3); // s1, s2, s3 (s2 once)
    expect(rollup.lastInvokedAt).toEqual(new Date("2026-01-05"));
  });
});

/**
 * ISS-5534 (whitlockk review on #4902): the parent-pack identity the list emits
 * beside a row's `invocations`, so a consumer can drop a plugin's rolled-up
 * total ONLY when that plugin's own children are in the same population —
 * instead of zeroing every plugin the moment any child-kind row appears.
 *
 * The plugin case asserts the emitted set is the SAME one the rollup summed
 * over (`pluginPackCandidates`), because an identity that disagreed with the
 * number would be worse than no identity at all.
 */
describe("emitPackIdentity (ISS-5534)", () => {
  it("emits a plugin's full rollup candidate set, sorted", () => {
    const merged = {
      kind: AgentComponentKind.Plugin,
      key: "rtk",
      packIds: new Set(["p2", "p1"]),
    };
    expect(emitPackIdentity(merged)).toEqual({
      packIds: ["p1", "p2", "rtk"],
    });
    // The identity and the number describe the same thing.
    expect(emitPackIdentity(merged).packIds).toEqual(
      [...pluginPackCandidates(merged)].sort()
    );
  });

  it("emits the pack a CHILD row belongs to, without folding in its own key", () => {
    expect(
      emitPackIdentity({
        kind: AgentComponentKind.Skill,
        key: "code-review",
        packIds: new Set(["rtk"]),
      })
    ).toEqual({ packIds: ["rtk"] });
  });

  it("OMITS the field for a component that belongs to no pack", () => {
    // Never `[]`, never `null` — absence is the skew-safe wire shape, and on a
    // non-plugin row it honestly means "no pack".
    expect(
      emitPackIdentity({
        kind: AgentComponentKind.Subagent,
        key: "orchestrator",
        packIds: new Set(),
      })
    ).toEqual({});
  });

  it("OMITS the field for a key-less plugin with no folded packs", () => {
    expect(
      emitPackIdentity({
        kind: AgentComponentKind.Plugin,
        key: null,
        packIds: new Set(),
      })
    ).toEqual({});
  });
});
