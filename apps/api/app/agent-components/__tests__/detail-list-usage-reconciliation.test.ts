/**
 * ISS-5363 regression suite: the component DETAIL page and the component LIST
 * table must report the same invocations/sessions for the same component.
 *
 * The observed defect (on the `create-feat` skill) was a detail page reading
 * `INVOCATIONS 0` / `SESSIONS 0` beside a list row showing real usage. The two
 * surfaces never disagreed about ATTRIBUTION — since ISS-4630 both credit a
 * usage group by its own `(componentKind, componentKey)`. They disagreed about
 * what gets LOADED:
 *
 *   - the LIST's FK read is bounded by EVERY inventory id in the org, so a usage
 *     row installed as Y but FK-linked to X's inventory row is read and folded
 *     onto Y;
 *   - the DETAIL's FK read was bounded by ONE family's inventory ids, so that
 *     same row was never read, and the orphan lane could not recover it either
 *     (`fetchDetailOrphanUsage` matches only usage no live inventory row owns).
 *
 * `loadUsageGroupsLinkedElsewhere` adds the missing lane. These tests assert the
 * reconciliation DIRECTLY — one declared row set, both surfaces, `detail ===
 * list` — rather than pinning two independent constants, because two constants
 * drift the moment either derivation moves.
 *
 * The detail-side Prisma double here EVALUATES the `where` clause instead of
 * returning a canned list. That is load-bearing: a double that ignores
 * `agentComponentId` would return the elsewhere-linked rows to the OLD code too,
 * and the regression would pass against the bug.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
  listByArtifactIds: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import { loadUsageGroupsLinkedElsewhere } from "../org-population";
import { agentComponentsService } from "../service";

const ORGANIZATION_ID = "org-iss-5363";
const SKILL_KEY = "create-feat";
const SKILL_SLUG = encodeComponentSlug(
  AgentComponentKind.Skill,
  SKILL_KEY,
  null
);
const OTHER_KEY = "unrelated-skill";
const PLUGIN_KEY = "some-pack";
/** ISS-6180: the plugin CHILD identity carried by both a live and a dead row. */
const CHILD_KEY = "gstack-nav";
const SEEN_AT = new Date("2026-08-01T00:00:00.000Z");

/** One `AgentComponentSessionUsage` row, as the table actually stores it. */
type UsageRow = {
  id: string;
  /** The inventory row the FK points at — NOT necessarily this row's family. */
  agentComponentId: string | null;
  agentSessionId: string;
  componentKind: string;
  componentKey: string;
  invocationCount: number;
  errorCount: number;
  gitBranch: string;
  harness: string | null;
  componentVersionHash: string | null;
  definitionVersionId: string | null;
  lastInvokedAt: Date | null;
};

/** One `AgentComponent` inventory row. */
type InventoryRow = {
  id: string;
  componentKind: string;
  componentKey: string | null;
  name: string | null;
  /** Null unless a fixture is exercising the plugin child-pack join. */
  packId?: string | null;
  /**
   * FEA-4086 tombstone. Non-null means the scanner can no longer see the row, so
   * `orgInventoryWhere` excludes it from the list's population — and therefore
   * from the detail's elsewhere-linked lane too (ISS-5363, wongk review).
   */
  uninstalledAt?: Date | null;
};

type Fixture = {
  inventory: InventoryRow[];
  usage: UsageRow[];
};

// ---------------------------------------------------------------------------
// A `where`-evaluating Prisma double.
// ---------------------------------------------------------------------------

type Filter = Record<string, unknown>;

function lower(value: unknown): unknown {
  return typeof value === "string" ? value.toLowerCase() : value;
}

/** Evaluate one field-level Prisma filter (`equals`/`in`/`notIn`/`not`/…). */
function matchesFieldFilter(actual: unknown, filter: unknown): boolean {
  if (filter === null || typeof filter !== "object") {
    return actual === filter;
  }
  const spec = filter as Filter;
  const insensitive = spec.mode === "insensitive";
  const normalize = (value: unknown) => (insensitive ? lower(value) : value);
  if ("equals" in spec && normalize(actual) !== normalize(spec.equals)) {
    return false;
  }
  if (
    "in" in spec &&
    !(spec.in as unknown[]).map(normalize).includes(normalize(actual))
  ) {
    return false;
  }
  if (
    "notIn" in spec &&
    (spec.notIn as unknown[]).map(normalize).includes(normalize(actual))
  ) {
    return false;
  }
  if ("not" in spec && !matchesNot(actual, spec.not)) {
    return false;
  }
  return true;
}

function matchesNot(actual: unknown, not: unknown): boolean {
  if (not === null) {
    return actual !== null;
  }
  return !matchesFieldFilter(actual, not);
}

/**
 * Evaluate a row-level `where`. Supports exactly the shapes the reads under test
 * emit — scalar equality, field filters, `OR`, `AND`, and the nested
 * `session.artifact.organizationId` org scope. An unrecognized key THROWS rather
 * than being ignored, so a future predicate cannot silently go unenforced and
 * leave a green test asserting nothing.
 */
function matchesWhere(
  row: Record<string, unknown>,
  where: Filter | undefined,
  orgScopeKeys: readonly string[]
): boolean {
  if (!where) {
    return true;
  }
  for (const [field, filter] of Object.entries(where)) {
    if (USAGE_RELATION_KEYS.includes(field)) {
      const related = row[field];
      // Prisma's to-one relation filter is `is`-shaped: a NULL relation matches
      // no nested predicate. That is what keeps ISS-6180's two orphan arms
      // (`agentComponentId: null` and a tombstoned FK) disjoint rather than
      // overlapping on every unlinked row.
      if (
        !(
          related &&
          matchesWhere(
            related as Record<string, unknown>,
            filter as Filter,
            orgScopeKeys
          )
        )
      ) {
        return false;
      }
      continue;
    }
    if (field === "OR") {
      if (
        !(filter as Filter[]).some((arm) =>
          matchesWhere(row, arm, orgScopeKeys)
        )
      ) {
        return false;
      }
      continue;
    }
    if (field === "AND") {
      if (
        !(filter as Filter[]).every((arm) =>
          matchesWhere(row, arm, orgScopeKeys)
        )
      ) {
        return false;
      }
      continue;
    }
    if (orgScopeKeys.includes(field)) {
      // Every fixture row belongs to ORGANIZATION_ID; the org predicate is
      // asserted separately rather than modelled per row.
      continue;
    }
    if (!(field in row)) {
      throw new Error(`double does not model predicate on "${field}"`);
    }
    if (!matchesFieldFilter(row[field], filter)) {
      return false;
    }
  }
  return true;
}

const USAGE_ORG_SCOPE_KEYS = ["session"];
/**
 * Usage-row fields holding a RELATED ROW rather than a scalar, matched by
 * recursing into the related row. Modelled rather than org-scope-skipped because
 * ISS-6180's usage-only lane admits a row by its FK TARGET's `uninstalledAt`, so
 * a double that waved this through would return the tombstoned rows to the old
 * code too and the regression would pass against the bug.
 */
const USAGE_RELATION_KEYS = ["agentComponent"];
// Only `organizationId` is asserted separately; `uninstalledAt` IS modelled per
// row, because the tombstone predicate is exactly what bounds the list's
// population and this suite asserts the detail shares that bound.
const INVENTORY_ORG_SCOPE_KEYS = ["organizationId"];

/** Group usage rows by the real `groupBy.by` tuple and aggregate them. */
function groupUsageRows(rows: UsageRow[], by: string[]) {
  const buckets = new Map<string, { key: Filter; rows: UsageRow[] }>();
  for (const row of rows) {
    const asRecord = row as unknown as Record<string, unknown>;
    const keyFields: Filter = {};
    for (const field of by) {
      keyFields[field] = asRecord[field];
    }
    const bucketKey = JSON.stringify(by.map((field) => asRecord[field]));
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.rows.push(row);
    } else {
      buckets.set(bucketKey, { key: keyFields, rows: [row] });
    }
  }
  return [...buckets.values()].map(({ key, rows: bucketRows }) => ({
    ...key,
    _sum: {
      invocationCount: bucketRows.reduce((n, r) => n + r.invocationCount, 0),
      errorCount: bucketRows.reduce((n, r) => n + r.errorCount, 0),
    },
    _max: {
      lastInvokedAt: bucketRows.reduce<Date | null>(
        (max, r) =>
          r.lastInvokedAt && (!max || r.lastInvokedAt > max)
            ? r.lastInvokedAt
            : max,
        null
      ),
    },
    _min: { firstInvokedAt: null },
  }));
}

function toDetailInventoryRow(row: InventoryRow) {
  return {
    packId: null,
    uninstalledAt: null,
    ...row,
    computeTargetId: "ct-1",
    externalComponentId: `ext-${row.id}`,
    harness: "claude",
    sourceUrl: null,
    installPath: null,
    scope: null,
    projectPath: null,
    description: null,
    metadata: null,
    content: null,
    contentHash: null,
    resolvedState: "resolved",
    variantsTruncated: false,
    variantsTruncatedReason: null,
    firstSeenAt: SEEN_AT,
    lastSeenAt: SEEN_AT,
    computeTarget: { id: "ct-1", userId: "user-1" },
  };
}

/**
 * Build a Prisma double over `fixture` that honors the actual `where` clauses.
 * Reads the detail path issues but this suite does not exercise resolve to empty
 * sets; a delegate the path reaches that is NOT modelled here throws.
 */
function buildReconciliationDb(fixture: Fixture) {
  const inventoryById = new Map(
    fixture.inventory.map((row) => [
      row.id,
      { packId: null, uninstalledAt: null, ...row } as Record<string, unknown>,
    ])
  );
  // Resolve each usage row's `agentComponent` relation from the fixture's own
  // inventory, so a relation-scoped predicate is EVALUATED against the row the FK
  // really points at (see {@link USAGE_RELATION_KEYS}).
  const asUsageRecord = (row: UsageRow): Record<string, unknown> => ({
    ...row,
    agentComponent: row.agentComponentId
      ? (inventoryById.get(row.agentComponentId) ?? null)
      : null,
  });
  const matchingUsage = (where: Filter | undefined) =>
    fixture.usage.filter((row) =>
      matchesWhere(asUsageRecord(row), where, USAGE_ORG_SCOPE_KEYS)
    );
  const usageGroupBy = vi.fn((args: { by: string[]; where?: Filter }) =>
    Promise.resolve(groupUsageRows(matchingUsage(args.where), args.by))
  );
  const usageFindMany = vi.fn((args: { where?: Filter }) =>
    Promise.resolve(matchingUsage(args.where))
  );
  const inventoryFindMany = vi.fn((args: { where?: Filter }) =>
    Promise.resolve(
      fixture.inventory
        .filter((row) =>
          matchesWhere(
            { packId: null, uninstalledAt: null, ...row } as unknown as Record<
              string,
              unknown
            >,
            args.where,
            INVENTORY_ORG_SCOPE_KEYS
          )
        )
        .map(toDetailInventoryRow)
    )
  );
  const empty = () => vi.fn(() => Promise.resolve([]));
  // ISS-6180: the identity-spine read `readOrgInventoryIds` /
  // `readOrgInventoryRows` issue before their row read. Named and exposed (rather
  // than an anonymous `empty()`) so a test can attribute the LIVE-INVENTORY BOUND
  // to a specific client — it is the only caller of this delegate on either path,
  // which makes it a clean marker for which snapshot that bound was read on.
  const inventoryGroupBy = vi.fn(() => Promise.resolve([]));
  return {
    usageGroupBy,
    usageFindMany,
    inventoryFindMany,
    inventoryGroupBy,
    db: {
      agentComponent: {
        findMany: inventoryFindMany,
        groupBy: inventoryGroupBy,
      },
      agentComponentSessionUsage: {
        groupBy: usageGroupBy,
        findMany: usageFindMany,
      },
      agentComponentVersion: { findMany: empty() },
      definitionVersion: { findMany: empty() },
      definitionVersionEditor: { findMany: empty() },
      sessionDetail: { findMany: empty() },
      agentComponentInvocation: { findMany: empty(), groupBy: empty() },
      artifactLink: { findMany: empty() },
      computeTarget: { findMany: empty() },
      user: { findMany: empty() },
    },
  };
}

function installDb(fixture: Fixture) {
  const built = buildReconciliationDb(fixture);
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(built.db)
  );
  return built;
}

function usageRow(overrides: Partial<UsageRow> & { id: string }): UsageRow {
  return {
    agentComponentId: null,
    agentSessionId: `session-${overrides.id}`,
    componentKind: AgentComponentKind.Skill,
    componentKey: SKILL_KEY,
    invocationCount: 1,
    errorCount: 0,
    gitBranch: "",
    harness: "claude",
    componentVersionHash: null,
    definitionVersionId: null,
    lastInvokedAt: SEEN_AT,
    ...overrides,
  };
}

/**
 * The reported shape: `create-feat` has its own inventory row, but its usage
 * rows carry an `agentComponentId` pointing at a DIFFERENT family's inventory
 * row. The list credits them to `create-feat` (own identity); the detail could
 * not see them at all.
 */
function elsewhereLinkedFixture(): Fixture {
  return {
    inventory: [
      {
        id: "inv-create-feat",
        componentKind: AgentComponentKind.Skill,
        componentKey: SKILL_KEY,
        name: SKILL_KEY,
      },
      {
        id: "inv-other",
        componentKind: AgentComponentKind.Skill,
        componentKey: OTHER_KEY,
        name: OTHER_KEY,
      },
    ],
    usage: [
      usageRow({
        id: "u1",
        agentComponentId: "inv-other",
        agentSessionId: "session-a",
        invocationCount: 7,
      }),
      usageRow({
        id: "u2",
        agentComponentId: "inv-other",
        agentSessionId: "session-b",
        invocationCount: 5,
      }),
    ],
  };
}

/**
 * ISS-6180 (wongk review on #5039): `create-feat` was also installed on a device
 * the scanner can no longer see. That row is TOMBSTONED, not deleted, and its
 * usage still carries the FK — so EVERY FK lane misses it (all of them are
 * bounded by the ids of an `uninstalledAt: null` inventory read) and the orphan
 * lane missed it too while it demanded `agentComponentId IS NULL`. The
 * invocations belonged to no lane at all and vanished from both surfaces.
 */
function tombstonedFkFixture(): Fixture {
  return {
    inventory: [
      {
        id: "inv-create-feat",
        componentKind: AgentComponentKind.Skill,
        componentKey: SKILL_KEY,
        name: SKILL_KEY,
      },
      {
        id: "inv-create-feat-dead",
        componentKind: AgentComponentKind.Skill,
        componentKey: SKILL_KEY,
        name: SKILL_KEY,
        uninstalledAt: SEEN_AT,
      },
    ],
    usage: [
      usageRow({
        id: "u1",
        agentComponentId: "inv-create-feat",
        agentSessionId: "session-a",
        invocationCount: 3,
      }),
      usageRow({
        id: "u2",
        agentComponentId: "inv-create-feat-dead",
        agentSessionId: "session-b",
        invocationCount: 9,
      }),
    ],
  };
}

/**
 * ISS-6180 (shafty023 review on #5039): a plugin whose child is installed on TWO
 * devices under ONE `(kind, key)` — one live, one TOMBSTONED — with usage
 * FK-linked to each.
 *
 * Scoping the child-inventory join to live children does not settle this case.
 * The live sibling still contributes `skill::gstack-nav` to `packIdsByIdentity`
 * and to the SQL identity prefilter, so the dead row's usage is admitted, its FK
 * misses the live-only `packIdByComponentId`, and `resolveUsagePackId` falls back
 * to the live sibling's identity. The plugin then rolls up BOTH rows while the
 * usage-only lane also reports the dead one — the double-count ISS-6180 exists to
 * remove, still reachable.
 *
 * The child row is the control: it legitimately carries both (its own FK lane
 * plus the usage-only lane), so a fix that merely hid the dead row everywhere
 * would move the child off 9 and be caught here.
 */
function pluginTombstonedChildFixture(): Fixture {
  return {
    inventory: [
      {
        id: "inv-plugin",
        componentKind: AgentComponentKind.Plugin,
        componentKey: PLUGIN_KEY,
        name: PLUGIN_KEY,
      },
      {
        id: "inv-child-live",
        componentKind: AgentComponentKind.Skill,
        componentKey: CHILD_KEY,
        name: CHILD_KEY,
        packId: PLUGIN_KEY,
      },
      {
        id: "inv-child-dead",
        componentKind: AgentComponentKind.Skill,
        componentKey: CHILD_KEY,
        name: CHILD_KEY,
        packId: PLUGIN_KEY,
        uninstalledAt: SEEN_AT,
      },
    ],
    usage: [
      usageRow({
        id: "u-child-live",
        agentComponentId: "inv-child-live",
        agentSessionId: "session-child-live",
        componentKey: CHILD_KEY,
        invocationCount: 4,
      }),
      usageRow({
        id: "u-child-dead",
        agentComponentId: "inv-child-dead",
        agentSessionId: "session-child-dead",
        componentKey: CHILD_KEY,
        invocationCount: 5,
      }),
    ],
  };
}

/**
 * The PRODUCTION list read (`agentComponentsService.listForOrg`) against the SAME
 * `where`-evaluating double, and the row it produced for one component.
 *
 * wongk (ISS-5363 review): this used to be a hand-written reimplementation of the
 * list's fold. A reimplementation makes the reconciliation vacuous — `listForOrg`
 * could regress and this suite would stay green comparing the detail against a
 * copy that never moved. Running the real derivation is what makes
 * `detail === list` a claim about production.
 *
 * Returns `null` when the list produced no row at all, so a missing row fails as
 * a missing row rather than silently reading as a zero.
 */
async function listUsageForKey(componentKey: string) {
  const list = await agentComponentsService.listForOrg(
    ORGANIZATION_ID,
    LIST_QUERY
  );
  const row = list.items.find(
    (item) => item.name.toLowerCase() === componentKey.toLowerCase()
  );
  return row ? { invocations: row.invocations, sessions: row.sessions } : null;
}

/** A whole-population list read: no facets, page large enough for any fixture. */
const LIST_QUERY = { limit: 200, offset: 0 } as Parameters<
  typeof agentComponentsService.listForOrg
>[1];

describe("ISS-5363 — detail/list invocation reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("reports the same invocations and sessions the list credits, for usage FK-linked to another family", async () => {
    const fixture = elsewhereLinkedFixture();
    installDb(fixture);

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SKILL_SLUG
    );
    const list = await listUsageForKey(SKILL_KEY);

    // A DIRECT comparison — same component, same instant, same declared rows,
    // and BOTH sides are the production derivation.
    expect(list).not.toBeNull();
    expect(detail?.invocations).toBe(list?.invocations);
    expect(detail?.sessions).toBe(list?.sessions);
    // And the value is the real one, not a coincidental shared zero.
    expect(list?.invocations).toBe(12);
    expect(detail?.invocations).toBe(12);
    expect(detail?.sessions).toBe(2);
  });

  it("does not double-count usage FK-linked to this family's own inventory row", async () => {
    // The two lanes are disjoint by construction (`in` vs `notIn` over the same
    // inventory ids). Without that, a row satisfying both predicates would be
    // summed twice and the detail would read HIGH — the same divergence pointed
    // the other way.
    const fixture = elsewhereLinkedFixture();
    fixture.usage.push(
      usageRow({
        id: "u3",
        agentComponentId: "inv-create-feat",
        agentSessionId: "session-c",
        invocationCount: 4,
      })
    );
    installDb(fixture);

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SKILL_SLUG
    );

    expect(detail?.invocations).toBe(
      (await listUsageForKey(SKILL_KEY))?.invocations
    );
    expect(detail?.invocations).toBe(16);
    expect(detail?.sessions).toBe(3);
  });

  it("counts usage FK-linked to a TOMBSTONED inventory row, once, on both surfaces (ISS-6180)", async () => {
    installDb(tombstonedFkFixture());

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SKILL_SLUG
    );
    const list = await listUsageForKey(SKILL_KEY);

    expect(list).not.toBeNull();
    expect(detail?.invocations).toBe(list?.invocations);
    expect(detail?.sessions).toBe(list?.sessions);
    // 12, not 3: the dead row's 9 are recovered by the usage-only lane. And not
    // 15 either — the live row's 3 are claimed by the FK lane alone, so widening
    // the orphan lane did not make the two overlap.
    expect(list?.invocations).toBe(12);
    expect(detail?.sessions).toBe(2);
  });

  it("still excludes usage belonging to another family that is FK-linked here", async () => {
    // The ISS-4660 direction must stay closed: a row FK-linked to `create-feat`
    // but installed as something else is the OTHER family's usage.
    const fixture = elsewhereLinkedFixture();
    fixture.usage.push(
      usageRow({
        id: "u4",
        agentComponentId: "inv-create-feat",
        agentSessionId: "session-d",
        componentKey: OTHER_KEY,
        invocationCount: 99,
      })
    );
    installDb(fixture);

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SKILL_SLUG
    );

    expect(detail?.invocations).toBe(
      (await listUsageForKey(SKILL_KEY))?.invocations
    );
    expect(detail?.invocations).toBe(12);
  });

  it("reports a plugin with no resolvable children as the same 0 the list reports", async () => {
    // wongk (ISS-5363 review). A plugin has no direct usage rows: its totals are
    // the sum over its candidate packs' CHILD inventory. When no child inventory
    // resolves, that sum is empty — and the LIST reaches it through the very same
    // short-circuit (`loadChildUsageByPackId` returns an empty map on an empty
    // `identityPrefilter`, and `sumPluginChildUsage` REPLACES the plugin's
    // aggregates with 0). Dashing on the detail would MANUFACTURE the cross
    // surface disagreement this suite exists to prove absent.
    installDb({
      inventory: [
        {
          id: "inv-plugin",
          componentKind: AgentComponentKind.Plugin,
          componentKey: PLUGIN_KEY,
          name: PLUGIN_KEY,
        },
      ],
      usage: [],
    });

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Plugin, PLUGIN_KEY, null)
    );
    const list = await listUsageForKey(PLUGIN_KEY);

    expect(detail).not.toBeNull();
    expect(list).not.toBeNull();
    expect(detail?.invocations).toBe(list?.invocations);
    expect(detail?.sessions).toBe(list?.sessions);
    expect(detail?.invocations).toBe(0);
    expect(detail?.sessions).toBe(0);
  });

  it("keeps a tombstoned child out of its plugin's rollup when a LIVE sibling shares its identity (ISS-6180, shafty023)", async () => {
    installDb(pluginTombstonedChildFixture());

    const pluginDetail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      encodeComponentSlug(AgentComponentKind.Plugin, PLUGIN_KEY, null)
    );
    const pluginList = await listUsageForKey(PLUGIN_KEY);
    const childList = await listUsageForKey(CHILD_KEY);

    expect(pluginList).not.toBeNull();
    expect(childList).not.toBeNull();
    // The plugin sums its LIVE children only: 4, not 9. Before the fix the dead
    // row reached the rollup through the live sibling's identity, so the plugin
    // reported 9 while the usage-only lane ALSO reported that same 5 — one
    // invocation in two places in a single response.
    expect(pluginList?.invocations).toBe(4);
    expect(pluginList?.sessions).toBe(1);
    // The detail applies the exclusion in its OWN read, so it is pinned to the
    // absolute value as well as to the list. Comparing it only against the list
    // would pass at 9 === 9 if both surfaces regressed together, which is
    // exactly what a shared-helper fix makes likely.
    expect(pluginDetail?.invocations).toBe(4);
    expect(pluginDetail?.sessions).toBe(1);
    expect(pluginDetail?.invocations).toBe(pluginList?.invocations);
    expect(pluginDetail?.sessions).toBe(pluginList?.sessions);
    // …and the CHILD still reports both rows (its own FK lane plus the
    // usage-only lane), so the dead row's invocations are not LOST — only
    // attributed once, to the component that actually owns them.
    expect(childList?.invocations).toBe(9);
    expect(childList?.sessions).toBe(2);
  });

  it("reports a REAL zero as 0, not as the unavailable dash", async () => {
    // The false-0 guard must not swallow a genuine zero: this identity resolves,
    // both lanes ran, and there is simply no usage.
    installDb({
      inventory: [
        {
          id: "inv-create-feat",
          componentKind: AgentComponentKind.Skill,
          componentKey: SKILL_KEY,
          name: SKILL_KEY,
        },
      ],
      usage: [],
    });

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SKILL_SLUG
    );

    expect(detail?.invocations).toBe(
      (await listUsageForKey(SKILL_KEY))?.invocations
    );
    expect(detail?.invocations).toBe(0);
    expect(detail?.sessions).toBe(0);
  });

  it("counts usage FK-linked to a tombstoned inventory row on BOTH surfaces (ISS-6180)", async () => {
    // BEHAVIOR CHANGE (wongk review on #5039). Under ISS-5363 this row was
    // dropped by both surfaces: the elsewhere-linked lane is bounded by the
    // LIST's own CURRENT inventory ids, its FK lane reads only `uninstalledAt:
    // null` rows, and the orphan lane demanded a NULL FK. That reconciled, but
    // only by LOSING the invocations — a tombstoned link made real usage vanish
    // from the product entirely, and ISS-6180's live-inventory scoping of the
    // plugin rollup widened that hole. The usage-only lane now admits it.
    //
    // The claim this suite exists for is unchanged and still asserted: detail
    // equals list, in either direction. Only the shared value moved, because both
    // surfaces gained the same lane.
    const fixture = elsewhereLinkedFixture();
    fixture.inventory.push({
      id: "inv-tombstoned",
      componentKind: AgentComponentKind.Skill,
      componentKey: OTHER_KEY,
      name: OTHER_KEY,
      uninstalledAt: SEEN_AT,
    });
    fixture.usage.push(
      usageRow({
        id: "u5",
        agentComponentId: "inv-tombstoned",
        agentSessionId: "session-e",
        invocationCount: 50,
      })
    );
    installDb(fixture);

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SKILL_SLUG
    );
    const list = await listUsageForKey(SKILL_KEY);

    expect(detail?.invocations).toBe(list?.invocations);
    // 62 = the 12 already reconciled, plus the 50 the tombstoned link hid.
    expect(detail?.invocations).toBe(62);
    expect(detail?.sessions).toBe(3);
  });
});

describe("loadUsageGroupsLinkedElsewhere — content-scoped identity bound", () => {
  /**
   * wongk (ISS-5363 review): `usageContentScopeWhere` returns its OWN `OR`, so
   * SPREADING it beside the componentKey `OR` REPLACED the name predicate on
   * every content-hash route — the lane then grouped every same-kind row in that
   * content scope. This drives the real function against a `where`-evaluating
   * double, so the assertion fails if the two predicates stop being AND-ed.
   */
  it("keeps the name predicate when a content scope is also applied", async () => {
    const rows: UsageRow[] = [
      usageRow({
        id: "match",
        agentComponentId: "inv-other",
        agentSessionId: "session-match",
        componentVersionHash: "hash-a",
        invocationCount: 3,
      }),
      usageRow({
        id: "wrong-name",
        agentComponentId: "inv-other",
        agentSessionId: "session-wrong-name",
        componentKey: OTHER_KEY,
        componentVersionHash: "hash-a",
        invocationCount: 99,
      }),
    ];
    const groupBy = vi.fn((args: { by: string[]; where?: Filter }) =>
      Promise.resolve(
        groupUsageRows(
          rows.filter((row) =>
            matchesWhere(
              row as unknown as Record<string, unknown>,
              args.where,
              [...USAGE_ORG_SCOPE_KEYS, "definitionVersion"]
            )
          ),
          args.by
        )
      )
    );
    const db = {
      agentComponentSessionUsage: { groupBy },
      definitionVersion: { findMany: vi.fn(() => Promise.resolve([])) },
    };

    const groups = await loadUsageGroupsLinkedElsewhere(
      db as never,
      ORGANIZATION_ID,
      AgentComponentKind.Skill,
      [SKILL_KEY],
      ["inv-other"],
      { fingerprint: "hash-a", contentHashes: ["hash-a"] }
    );

    expect(groups.map((group) => group.agentSessionId)).toEqual([
      "session-match",
    ]);
  });
});

/**
 * Wire the pooled `withDb` and the transactional `withDb.tx` to DISTINCT clients
 * built from the same fixture, so a lane that ran on the wrong one is
 * observable. Mirrors `org-population-snapshot.test.ts`, which pins the same
 * guarantee for the LIST's usage reads.
 */
function installSnapshotDb(fixture: Fixture) {
  const pooled = buildReconciliationDb(fixture);
  const tx = buildReconciliationDb(fixture);
  const capturedTxOptions: { isolationLevel?: string; timeout?: number }[] = [];
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(pooled.db)
  );
  mocks.withDb.tx.mockImplementation(
    (
      callback: (client: unknown) => unknown,
      options?: { isolationLevel?: string; timeout?: number }
    ) => {
      capturedTxOptions.push(options ?? {});
      return callback(tx.db);
    }
  );
  return { pooled, tx, capturedTxOptions };
}

/**
 * ISS-6180 (shafty023 review on #5039): wire the pooled client and the
 * transactional client to DIFFERENT fixtures, modelling a commit that landed
 * BETWEEN a pooled read and the transaction's snapshot.
 *
 * This is the only way to make the two-snapshot bug produce a WRONG NUMBER rather
 * than merely a differently-routed call: with one shared fixture, reading the
 * inventory bound on the pool is invisible, because both clients would answer
 * identically. Skewing them is the race.
 */
function installSkewedDb(pooledFixture: Fixture, txFixture: Fixture) {
  const pooled = buildReconciliationDb(pooledFixture);
  const tx = buildReconciliationDb(txFixture);
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(pooled.db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(tx.db)
  );
  return { pooled, tx };
}

/**
 * ISS-6180: one component with usage on two inventory rows — a live one and a
 * second whose tombstone state is what the two snapshots disagree about.
 * `deadRowUninstalledAt` is the ONLY difference between the two fixtures, so it
 * is the only thing a divergence can be attributed to.
 */
function tombstoneBoundaryFixture(deadRowUninstalledAt: Date | null): Fixture {
  return {
    inventory: [
      {
        id: "inv-create-feat",
        componentKind: AgentComponentKind.Skill,
        componentKey: SKILL_KEY,
        name: SKILL_KEY,
      },
      {
        id: "inv-create-feat-second",
        componentKind: AgentComponentKind.Skill,
        componentKey: SKILL_KEY,
        name: SKILL_KEY,
        uninstalledAt: deadRowUninstalledAt,
      },
    ],
    usage: [
      usageRow({
        id: "u1",
        agentComponentId: "inv-create-feat",
        agentSessionId: "session-a",
        invocationCount: 3,
      }),
      usageRow({
        id: "u2",
        agentComponentId: "inv-create-feat-second",
        agentSessionId: "session-b",
        invocationCount: 9,
      }),
    ],
  };
}

/** The usage-only-lane calls a usage `findMany` recorded (ISS-6180 shape). */
function orphanReadCalls(findMany: { mock: { calls: unknown[][] } }) {
  return findMany.mock.calls.filter(([args]) =>
    ((args as { where?: Filter })?.where?.AND as Filter[] | undefined)?.some(
      (clause) =>
        (clause.OR as Filter[] | undefined)?.some(
          (arm) => arm.agentComponentId === null
        )
    )
  );
}

const REPEATABLE_READ = "RepeatableRead";
// Matches `DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS` in
// `../service/detail-usage-identity` — the same generous ceiling the list's
// snapshot uses, so a large (but row-capped) org cannot regress into Prisma's
// 5s default interactive-transaction timeout.
const EXPECTED_SNAPSHOT_TX_TIMEOUT_MS = 30_000;

describe("getDetailForOrg — consistent usage snapshot (ISS-4669 / ISS-5363)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("reads all three usage lanes on the SAME transaction client, not the pooled connection", async () => {
    // wongk (ISS-5363 review): the FK lanes are disjoint only WITHIN one
    // snapshot. Run on the pool, a concurrent `agentComponentId` relink is
    // visible to both lanes or to neither, and the orphan read was a third
    // snapshot again.
    const { pooled, tx } = installSnapshotDb(elsewhereLinkedFixture());

    await agentComponentsService.getDetailForOrg(ORGANIZATION_ID, SKILL_SLUG);

    // Both FK lanes issued their `groupBy` on the transactional client …
    expect(tx.usageGroupBy).toHaveBeenCalledTimes(2);
    // … and the usage-only lane issued its row read
    // there too, rather than on a later pooled snapshot.
    expect(orphanReadCalls(tx.usageFindMany)).toHaveLength(1);
    expect(pooled.usageGroupBy).not.toHaveBeenCalled();
    // The pooled client still serves the detail's other usage reads (the
    // per-session version attribution), so assert on the ORPHAN LANE
    // specifically rather than on the delegate as a whole.
    expect(orphanReadCalls(pooled.usageFindMany)).toHaveLength(0);
  });

  it("reads the LIVE-INVENTORY BOUND in the same snapshot as the usage lanes (ISS-6180, shafty023)", async () => {
    // The bound and the usage-only lane partition on the SAME fact once that
    // lane keys on `agentComponent.uninstalledAt`. Resolved on the pool ahead of
    // the transaction it is a second snapshot, so a tombstone committing in
    // between keeps the id in the elsewhere-linked bound while the orphan lane
    // also claims the row, and a restore drops it from both.
    const { pooled, tx } = installSnapshotDb(elsewhereLinkedFixture());

    await agentComponentsService.getDetailForOrg(ORGANIZATION_ID, SKILL_SLUG);

    // `readOrgInventoryIds` is the only issuer of the inventory identity spine on
    // this path, so where that read landed is where the bound was resolved.
    expect(tx.inventoryGroupBy).toHaveBeenCalled();
    expect(pooled.inventoryGroupBy).not.toHaveBeenCalled();
  });

  it("counts a component once when a TOMBSTONE commits between the two reads (ISS-6180, shafty023)", async () => {
    // Pooled snapshot: the second row is still live. Transaction snapshot: it has
    // been tombstoned. With the bound read on the pool, its id stayed in the FK
    // lane's `in` list (which returns u2) while the transaction ALSO saw
    // `uninstalledAt != null` and admitted u2 to the usage-only lane — 3 + 9 + 9
    // = 21, the 9 counted twice in one response.
    installSkewedDb(
      tombstoneBoundaryFixture(null),
      tombstoneBoundaryFixture(SEEN_AT)
    );

    const list = await listUsageForKey(SKILL_KEY);

    // 12 = 3 + 9. Every usage row in exactly one lane, because both lanes and the
    // bound that separates them now come from ONE snapshot.
    expect(list?.invocations).toBe(12);
    expect(list?.sessions).toBe(2);
  });

  it("counts a component once when a RESTORE commits between the two reads (ISS-6180, shafty023)", async () => {
    // The same race pointed the other way, which a tombstone-only test would miss
    // entirely. Pooled snapshot: the second row is tombstoned, so its id was
    // absent from the bound and the FK lane never read u2. Transaction snapshot:
    // it has been restored, so the usage-only lane's `uninstalledAt != null` no
    // longer matches and dropped u2 as well — 3, with 9 invocations lost from the
    // product rather than double-counted.
    installSkewedDb(
      tombstoneBoundaryFixture(SEEN_AT),
      tombstoneBoundaryFixture(null)
    );

    const list = await listUsageForKey(SKILL_KEY);

    expect(list?.invocations).toBe(12);
    expect(list?.sessions).toBe(2);
  });

  it("counts the DETAIL once when a TOMBSTONE commits between the two reads (ISS-6180, shafty023 re-review)", async () => {
    // The OWN-FAMILY half of the same partition, which moving `readOrgInventoryIds`
    // alone did not close: the detail resolves `inventoryRows` on the pool and
    // hands their IDS down, where they bound both `ownIds` and the inventory lane.
    // Pooled snapshot: the second row is live, so its id enters that bound.
    // Transaction snapshot: it is tombstoned, so the usage-only lane claims u2 as
    // well and the detail reads 3 + 9 + 9 = 21 — the 9 counted twice in one
    // response. The list path cannot catch this; it has no own-family bound.
    // Only the tombstone direction is asserted: on a RESTORE the elsewhere-linked
    // lane already recovers the row (it is bounded by `orgInventoryIds`, which was
    // in-snapshot before this change), so a restore test here passes with OR
    // without the fix and would assert nothing.
    installSkewedDb(
      tombstoneBoundaryFixture(null),
      tombstoneBoundaryFixture(SEEN_AT)
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SKILL_SLUG
    );

    // 12 = 3 + 9, every usage row in exactly one lane, because the own-family
    // bound is now re-derived from its predicate inside the same snapshot.
    expect(detail?.invocations).toBe(12);
    expect(detail?.sessions).toBe(2);
  });

  it("opens the usage-read transaction at RepeatableRead isolation with a raised timeout", async () => {
    const { capturedTxOptions } = installSnapshotDb(elsewhereLinkedFixture());

    await agentComponentsService.getDetailForOrg(ORGANIZATION_ID, SKILL_SLUG);

    expect(capturedTxOptions).toHaveLength(1);
    expect(capturedTxOptions[0]?.isolationLevel).toBe(REPEATABLE_READ);
    expect(capturedTxOptions[0]?.timeout).toBe(EXPECTED_SNAPSHOT_TX_TIMEOUT_MS);
    // Guard the literal against a silent drift from the real Prisma enum member.
    expect(REPEATABLE_READ).toBe(
      mocks.Prisma.TransactionIsolationLevel.RepeatableRead
    );
  });
});
