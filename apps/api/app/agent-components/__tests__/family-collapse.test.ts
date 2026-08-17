/**
 * FEA-4267: the catalog LIST collapses a component FAMILY (multiple version
 * buckets that share the same org-level `slug`) into ONE canonical row, so the
 * Agents catalog no longer shows duplicate rows for the same logical component
 * (a `cl-prod` search returned COMPONENTS: 5 for one `cl-produce` skill). The
 * COMPONENTS `total` counts canonical families, pagination pages over families,
 * and per-version data still lives on the detail read.
 *
 * These are behavioral tests over the real `listForOrg` production path with a
 * mocked DB, mirroring the harness in `service.test.ts` but kept in a dedicated,
 * focused file so the grandfathered `service.test.ts` (already > 1000 lines) does
 * not grow.
 */
import { SourceType } from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  // ISS-4669: `buildOrgComponentPopulation` reads FK-linked + orphan usage in one
  // `withDb.tx({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })`
  // snapshot, so the mocked module must expose that enum value.
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: {
    listByArtifactIds: mocks.listByArtifactIds,
  },
}));

import { agentComponentsService } from "../service";
import {
  ensureInventorySpineDefault,
  isOrphanUsageRead,
} from "./usage-lane-doubles";

// ---------------------------------------------------------------------------
// Harness — a trimmed copy of service.test.ts's DB installer. The list path
// issues one `agentComponent.findMany` (inventory) plus a
// `agentComponentSessionUsage.groupBy` (usage rollup); `deriveUsageGroupBy`
// folds each inventory row's `sessionUsages` fixtures into the grouped rows the
// DB would return, keyed by the row's linked `contentHash` so distinct-hash rows
// of the same identity split into distinct version buckets (the pre-fix
// duplicate rows), then this feature collapses them.
// ---------------------------------------------------------------------------

type NestedUsageFixture = {
  agentSessionId: string;
  invocationCount: number;
  // ISS-4635: errors ride the same grouped lane as invocations, so a family's
  // collapsed `totalErrors` shares the invocation denominator its `errorRate`
  // divides by. Defaults to 0 for the fixtures that only care about invocations.
  errorCount?: number;
  gitBranch?: string;
  harness?: string | null;
  lastInvokedAt?: Date | null;
  componentVersionHash?: string | null;
  session?: { artifact?: { organizationId?: string } | null } | null;
};

type UsageGroupRow = {
  agentComponentId: string;
  agentSessionId: string;
  gitBranch: string;
  harness: string | null;
  componentVersionHash: string | null;
  definitionVersionId: string | null;
  // Mirrors the production `UsageGroupRow._sum` contract in identity.ts. Keeping
  // `errorCount` here is what lets the collapse suite actually drive
  // `foldVersionIntoFamily`'s `canonical.totalErrors += version.totalErrors`;
  // without it every bucket folds `?? 0` and the line is untested.
  _sum: { invocationCount: number; errorCount: number };
  _max: { lastInvokedAt: Date | null };
};

function deriveUsageGroupBy(
  rows: Array<{
    id: string;
    contentHash?: string | null;
    sessionUsages?: NestedUsageFixture[];
  }>,
  organizationId: string | undefined
): UsageGroupRow[] {
  const groups = new Map<string, UsageGroupRow>();
  for (const row of rows) {
    for (const usage of row.sessionUsages ?? []) {
      if (
        organizationId !== undefined &&
        usage.session?.artifact?.organizationId !== organizationId
      ) {
        continue;
      }
      const gitBranch = usage.gitBranch ?? "";
      const harness = usage.harness ?? null;
      // A usage row records the hash the component was at when it ran; default
      // to the inventory row's own `contentHash` so the fold routes it back to
      // the same version bucket the inventory row seeded.
      const versionHash = usage.componentVersionHash ?? row.contentHash ?? null;
      const mapKey = `${row.id} ${usage.agentSessionId} ${gitBranch} ${harness ?? ""} ${versionHash ?? ""}`;
      const lastInvokedAt = usage.lastInvokedAt ?? null;
      const existing = groups.get(mapKey);
      if (existing) {
        existing._sum.invocationCount += usage.invocationCount;
        existing._sum.errorCount += usage.errorCount ?? 0;
        if (
          lastInvokedAt &&
          (!existing._max.lastInvokedAt ||
            lastInvokedAt > existing._max.lastInvokedAt)
        ) {
          existing._max.lastInvokedAt = lastInvokedAt;
        }
      } else {
        groups.set(mapKey, {
          agentComponentId: row.id,
          agentSessionId: usage.agentSessionId,
          gitBranch,
          harness,
          componentVersionHash: versionHash,
          definitionVersionId: null,
          _sum: {
            invocationCount: usage.invocationCount,
            errorCount: usage.errorCount ?? 0,
          },
          _max: { lastInvokedAt },
        });
      }
    }
  }
  return [...groups.values()];
}

function installDb(db: Record<string, unknown>) {
  const dbWithDefaults = {
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentComponentInvocation: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    agentComponentVersion: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    definitionVersion: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    definitionVersionEditor: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    sourceOccurrence: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    artifactLink: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...db,
  };
  // ISS-4797: the org inventory read resolves an identity spine
  // (`agentComponent.groupBy`) before its row read; default it for cases that
  // override `agentComponent` with only `findMany`.
  ensureInventorySpineDefault(
    dbWithDefaults.agentComponent as Record<string, unknown>
  );
  const usageDelegate = dbWithDefaults.agentComponentSessionUsage as Record<
    string,
    unknown
  >;
  if (typeof usageDelegate.groupBy !== "function") {
    const inventoryDelegate = dbWithDefaults.agentComponent as {
      findMany: { mock: { results: Array<{ value: unknown }> } };
    };
    usageDelegate.groupBy = vi.fn(
      async (args?: {
        where?: { session?: { artifact?: { organizationId?: string } } };
      }) => {
        // ISS-4799: the ORPHAN (null-FK) lane reads through `groupBy` too. No
        // case here seeds orphan usage, so it must resolve EMPTY — answering it
        // with the FK-derived groups would mint a synthetic bucket per family
        // and split the very rows this suite asserts are collapsed.
        if (isOrphanUsageRead(args?.where)) {
          return [];
        }
        const organizationId = args?.where?.session?.artifact?.organizationId;
        const inventoryCall = inventoryDelegate.findMany.mock.results[0];
        const inventoryRows = inventoryCall
          ? ((await inventoryCall.value) as Array<{
              id: string;
              contentHash?: string | null;
              sessionUsages?: NestedUsageFixture[];
            }>)
          : [];
        return deriveUsageGroupBy(inventoryRows, organizationId);
      }
    );
  }
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
}

function buildInventoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ac-uuid-1",
    organizationId: "org-1",
    computeTargetId: "target-1",
    componentKind: "skill",
    externalComponentId: "skill::cl-produce",
    harness: "claude",
    name: "cl-produce",
    componentKey: "cl-produce",
    contentHash: null,
    sourceUrl: null,
    installPath: null,
    packId: null,
    scope: null,
    projectPath: null,
    metadata: null,
    resolvedState: "unresolved",
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-01-10T00:00:00.000Z"),
    computeTarget: { id: "target-1", userId: "user-1" },
    sessionUsages: [],
    ...overrides,
  };
}

/** One usage fixture attributed to `org-1` for `agentSessionId`. */
function usage(
  agentSessionId: string,
  invocationCount: number,
  lastInvokedAt: Date | null = null
): NestedUsageFixture {
  return {
    agentSessionId,
    invocationCount,
    lastInvokedAt,
    session: { artifact: { organizationId: "org-1" } },
  };
}

// A `cl-produce` skill observed at FIVE distinct content fingerprints across the
// org — five inventory rows sharing (kind=skill, key=cl-produce) but differing
// only in `contentHash`. Pre-fix this materialized as five catalog rows.
function buildFiveVersionFamily() {
  return [
    buildInventoryRow({
      id: "ac-v1",
      contentHash: "hash-v1",
      computeTargetId: "target-1",
      computeTarget: { id: "target-1", userId: "user-1" },
      firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-01-02T00:00:00.000Z"),
      sessionUsages: [usage("sess-1", 3, new Date("2026-01-02T00:00:00.000Z"))],
    }),
    buildInventoryRow({
      id: "ac-v2",
      contentHash: "hash-v2",
      computeTargetId: "target-1",
      computeTarget: { id: "target-1", userId: "user-1" },
      firstSeenAt: new Date("2026-01-03T00:00:00.000Z"),
      lastSeenAt: new Date("2026-01-04T00:00:00.000Z"),
      sessionUsages: [usage("sess-2", 2, new Date("2026-01-04T00:00:00.000Z"))],
    }),
    buildInventoryRow({
      id: "ac-v3",
      contentHash: "hash-v3",
      computeTargetId: "target-2",
      computeTarget: { id: "target-2", userId: "user-2" },
      firstSeenAt: new Date("2026-01-05T00:00:00.000Z"),
      lastSeenAt: new Date("2026-01-06T00:00:00.000Z"),
      sessionUsages: [usage("sess-3", 5, new Date("2026-01-06T00:00:00.000Z"))],
    }),
    buildInventoryRow({
      id: "ac-v4",
      contentHash: "hash-v4",
      computeTargetId: "target-2",
      computeTarget: { id: "target-2", userId: "user-2" },
      firstSeenAt: new Date("2026-01-07T00:00:00.000Z"),
      lastSeenAt: new Date("2026-01-08T00:00:00.000Z"),
      // sess-1 recurs here (also in v1) — the union must count it once.
      sessionUsages: [usage("sess-1", 1, new Date("2026-01-08T00:00:00.000Z"))],
    }),
    buildInventoryRow({
      id: "ac-v5",
      contentHash: "hash-v5",
      computeTargetId: "target-3",
      computeTarget: { id: "target-3", userId: "user-3" },
      firstSeenAt: new Date("2026-01-09T00:00:00.000Z"),
      lastSeenAt: new Date("2026-01-10T00:00:00.000Z"),
      sessionUsages: [usage("sess-9", 4, new Date("2026-01-10T00:00:00.000Z"))],
    }),
  ];
}

describe("agentComponentsService.listForOrg — FEA-4267 family collapse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collapses a 5-version cl-produce family into ONE canonical catalog row", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue(buildFiveVersionFamily()),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    // 5 version buckets → 1 canonical row for the logical component.
    expect(result.items).toHaveLength(1);
    // The COMPONENTS count reflects canonical families, not raw version rows.
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);

    const [row] = result.items;
    expect(row.name).toBe("cl-produce");
    // FEA-4335: the emitted detail key is the CONTENT-HASH routable key of the
    // family's chosen representative version (the freshest, `hash-v5`), NOT the
    // name-level `skill::cl-produce` slug — so two distinct-content components
    // that normalize to one name no longer collide onto one detail URI. The
    // representative here is `hash-v5` (max lastInvokedAt/lastSeenAt).
    expect(row.slug).toBe("skill::hash-v5");

    // Usage AGGREGATES across every version: invocations SUM (3+2+5+1+4=15) and
    // sessions UNION (sess-1 seen twice → one) = {1,2,3,9} = 4 distinct.
    expect(row.invocations).toBe(15);
    expect(row.sessions).toBe(4);

    // Devices union + dedupe across versions: target-1/2/3.
    expect([...row.computeTargetIds].sort()).toEqual([
      "target-1",
      "target-2",
      "target-3",
    ]);

    // A multi-version family represents the whole component, so the per-version
    // badge is OMITTED (per-version identity lives on the detail page) and the
    // quiet version count surfaces instead.
    expect(row.versionId).toBeUndefined();
    expect(row.fingerprint).toBeUndefined();
    expect(row.versionCount).toBe(5);

    // The canonical representative is the LATEST version (v5, last invoked
    // 2026-01-10), so the row's lastInvokedAt is the max across versions.
    expect(row.lastInvokedAt).toBe(
      new Date("2026-01-10T00:00:00.000Z").toISOString()
    );
    // firstSeenAt is the min across versions; lastSeenAt the max.
    expect(row.firstSeenAt).toBe(
      new Date("2026-01-01T00:00:00.000Z").toISOString()
    );
    expect(row.lastSeenAt).toBe(
      new Date("2026-01-10T00:00:00.000Z").toISOString()
    );
  });

  it("keeps a single-version component as one row, badges its version, and omits versionCount", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            id: "ac-single",
            contentHash: "hash-single",
            sessionUsages: [
              usage("sess-1", 7, new Date("2026-01-10T00:00:00.000Z")),
            ],
          }),
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    const [row] = result.items;
    expect(row.invocations).toBe(7);
    // A single-version family keeps its version badge (unchanged behavior)…
    expect(row.versionId).toBe("hash-single");
    expect(row.fingerprint).toBeDefined();
    // …and emits NO `versionCount` (absence => "single / unversioned"), so the
    // quiet "N versions" signal never renders for a one-version component.
    expect(row.versionCount).toBeUndefined();
  });

  it("counts canonical families in total/hasMore across a multi-family org", async () => {
    // Two logical components: `cl-produce` with 5 versions, `other-skill` with 1.
    const rows = [
      ...buildFiveVersionFamily(),
      buildInventoryRow({
        id: "ac-other",
        componentKey: "other-skill",
        externalComponentId: "skill::other-skill",
        name: "other-skill",
        contentHash: "hash-other",
        sessionUsages: [
          usage("sess-o", 9, new Date("2026-01-11T00:00:00.000Z")),
        ],
      }),
    ];
    installDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue(rows) },
    });

    // Page size 1 proves pagination pages over FAMILIES (2), not the 6 raw
    // version rows: total=2 and hasMore=true after the first family.
    const firstPage = await agentComponentsService.listForOrg("org-1", {
      limit: 1,
      offset: 0,
    });
    expect(firstPage.total).toBe(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.items).toHaveLength(1);

    const secondPage = await agentComponentsService.listForOrg("org-1", {
      limit: 1,
      offset: 1,
    });
    expect(secondPage.total).toBe(2);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.items).toHaveLength(1);

    // The two pages together are the two distinct families — no version-row
    // duplicates leak across the page boundary. FEA-4335: each family emits its
    // representative version's CONTENT-HASH routable key (cl-produce's freshest
    // is `hash-v5`; the single-version other-skill's is `hash-other`), not the
    // name-level slug.
    const slugs = [
      ...firstPage.items.map((i) => i.slug),
      ...secondPage.items.map((i) => i.slug),
    ].sort();
    expect(slugs).toEqual(["skill::hash-other", "skill::hash-v5"]);
  });

  it("unions authors across every collapsed version of the family, deduped by user id", async () => {
    // Two versions of one skill link to two different fingerprints with two
    // different discoverers; the collapsed family row must show BOTH, once each.
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            id: "ac-fp-a",
            contentHash: "hash-a",
            lastSeenAt: new Date("2026-01-02T00:00:00.000Z"),
            sessionUsages: [
              usage("sess-a", 1, new Date("2026-01-02T00:00:00.000Z")),
            ],
          }),
          buildInventoryRow({
            id: "ac-fp-b",
            contentHash: "hash-b",
            lastSeenAt: new Date("2026-01-05T00:00:00.000Z"),
            sessionUsages: [
              usage("sess-b", 1, new Date("2026-01-05T00:00:00.000Z")),
            ],
          }),
        ]),
      },
      agentComponentVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            componentKind: "skill",
            componentKey: "cl-produce",
            contentHash: "hash-a",
            definitionVersion: { definitionHash: "fp-a" },
          },
          {
            componentKind: "skill",
            componentKey: "cl-produce",
            contentHash: "hash-b",
            definitionVersion: { definitionHash: "fp-b" },
          },
        ]),
      },
      definitionVersionEditor: {
        findMany: vi.fn().mockResolvedValue([
          {
            userId: "u-alice",
            firstEditedAt: new Date("2026-01-01T00:00:00Z"),
            definitionVersion: { definitionHash: "fp-a" },
            user: {
              id: "u-alice",
              firstName: "Alice",
              lastName: "A",
              email: "alice@example.com",
            },
          },
          // Alice also authored fp-b — the union must NOT double-count her when
          // she appears across two collapsed version buckets of the family.
          {
            userId: "u-alice",
            firstEditedAt: new Date("2026-01-03T00:00:00Z"),
            definitionVersion: { definitionHash: "fp-b" },
            user: {
              id: "u-alice",
              firstName: "Alice",
              lastName: "A",
              email: "alice@example.com",
            },
          },
          {
            userId: "u-bob",
            firstEditedAt: new Date("2026-01-04T00:00:00Z"),
            definitionVersion: { definitionHash: "fp-b" },
            user: {
              id: "u-bob",
              firstName: "Bob",
              lastName: "B",
              email: "bob@example.com",
            },
          },
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // Authors union across BOTH collapsed versions' lineage, deduped by user id
    // (Alice authored both versions but appears once).
    expect([...result.items[0].collaborators].sort()).toEqual([
      "Alice A",
      "Bob B",
    ]);
  });

  it("picks the freshest-INVOKED version as representative even when it has an older lastSeenAt (wongk)", async () => {
    // Two versions of one skill:
    //   v-old: invoked EARLIER (2026-01-05) but OBSERVED later (lastSeenAt
    //          2026-01-20) — a stale install that keeps getting re-scanned.
    //   v-new: invoked LATER  (2026-01-15) but OBSERVED earlier (lastSeenAt
    //          2026-01-10) — the genuinely newer revision.
    // The representative is ordered by real-invocation recency FIRST, so v-new
    // must supply the row's id/name/source. The bug: foldVersionIntoFamily
    // widens the aggregate lastInvokedAt to v-new's date before the compare, so
    // v-new ties itself, falls to the lastSeenAt tiebreak, and LOSES to v-old —
    // leaving v-old's stale id/source on a row that reports v-new's date.
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            id: "ac-old",
            contentHash: "hash-old",
            sourceUrl: "https://repo/old",
            firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
            lastSeenAt: new Date("2026-01-20T00:00:00.000Z"),
            sessionUsages: [
              usage("sess-old", 1, new Date("2026-01-05T00:00:00.000Z")),
            ],
          }),
          buildInventoryRow({
            id: "ac-new",
            contentHash: "hash-new",
            sourceUrl: "https://repo/new",
            firstSeenAt: new Date("2026-01-02T00:00:00.000Z"),
            lastSeenAt: new Date("2026-01-10T00:00:00.000Z"),
            sessionUsages: [
              usage("sess-new", 1, new Date("2026-01-15T00:00:00.000Z")),
            ],
          }),
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    const [row] = result.items;
    // Representative display fields come from the freshest-INVOKED version…
    expect(row.id).toBe("ac-new");
    expect(row.source).toBe("https://repo/new");
    // …while the aggregate dates still widen to the max across versions: the
    // real last-invocation is v-new's, the lastSeenAt is v-old's later scan.
    expect(row.lastInvokedAt).toBe(
      new Date("2026-01-15T00:00:00.000Z").toISOString()
    );
    expect(row.lastSeenAt).toBe(
      new Date("2026-01-20T00:00:00.000Z").toISOString()
    );
  });

  it("dedupes a device that appears twice in the FIRST version bucket (wongk)", async () => {
    // Two inventory rows for the SAME version (same contentHash) and the SAME
    // device — mergeComponentRows pushes `target-dup` into one bucket twice, so
    // the first-seen family bucket seeds computeTargetIds already containing a
    // duplicate. The fold dedupes LATER buckets via .includes(), but the first
    // bucket's own duplicate only clears if the clone seeds through a Set.
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            id: "ac-dup-a",
            contentHash: "hash-shared",
            computeTargetId: "target-dup",
            computeTarget: { id: "target-dup", userId: "user-dup" },
            sessionUsages: [
              usage("sess-1", 1, new Date("2026-01-02T00:00:00.000Z")),
            ],
          }),
          buildInventoryRow({
            id: "ac-dup-b",
            contentHash: "hash-shared",
            computeTargetId: "target-dup",
            computeTarget: { id: "target-dup", userId: "user-dup" },
            sessionUsages: [
              usage("sess-2", 1, new Date("2026-01-03T00:00:00.000Z")),
            ],
          }),
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    // One device on the family row, not two — even though it seeded the first
    // (and only) bucket twice.
    expect(result.items[0].computeTargetIds).toEqual(["target-dup"]);
  });

  // ISS-5009: the provenance columns must travel with the representative. The
  // fold re-homes the chosen revision's fields ONE BY ONE, so a subset adoption
  // leaves the family row resolving provenance from a revision it is not
  // otherwise showing — the newest version's fields beside an older version's
  // scope.
  it("adopts the freshest version's scope, so the family's honestSource describes the revision it displays", async () => {
    // v-project (scope "project", invoked 2026-01-05) vs v-user (scope "user",
    // invoked 2026-01-15). v-user is the freshest-invoked representative, so the
    // family must read `{Local, "user"}` — NOT v-project's `{Repo, "project"}`.
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            id: "ac-project",
            contentHash: "hash-project",
            scope: "project",
            projectPath: "/repo/.claude",
            sessionUsages: [
              usage("sess-project", 1, new Date("2026-01-05T00:00:00.000Z")),
            ],
          }),
          buildInventoryRow({
            id: "ac-user",
            contentHash: "hash-user",
            scope: "user",
            projectPath: null,
            sessionUsages: [
              usage("sess-user", 1, new Date("2026-01-15T00:00:00.000Z")),
            ],
          }),
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    const [row] = result.items;
    // The representative IS v-user…
    expect(row.id).toBe("ac-user");
    // …so its provenance is v-user's, not the stale v-project scope/path.
    expect(row.honestSource).toEqual({
      hasProvenance: true,
      source: "user",
      sourceType: SourceType.Local,
    });
  });

  // ISS-5009: pack MEMBERSHIP is the case the scope test above cannot reach.
  // `packIds` is a cross-version UNION built by `foldVersionIntoFamily` — it is
  // load-bearing for the plugin child-usage rollup and for the LEGACY
  // `resolveMergedSource`/`resolveMergedSourceType`, so it must NOT be re-homed
  // onto the representative. The honest projection therefore needs its OWN
  // representative-scoped pack id; reading the union's first member instead lets
  // the family report a pack belonging to a revision it is not displaying.
  it("resolves honestSource from the REPRESENTATIVE's pack id, not the family's unioned packIds", async () => {
    // v-legacy (packId "legacy-pack", invoked 2026-01-05) folds FIRST, so it is
    // the union's first member. v-new (NO pack, scope "user", invoked
    // 2026-01-15) wins the representative pick, so the honest projection must
    // read v-new's `{Local, "user"}` — a pack dot reading "legacy-pack" would
    // describe a revision this row is not showing.
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            id: "ac-legacy",
            contentHash: "hash-legacy",
            packId: "legacy-pack",
            sessionUsages: [
              usage("sess-legacy", 1, new Date("2026-01-05T00:00:00.000Z")),
            ],
          }),
          buildInventoryRow({
            id: "ac-new",
            contentHash: "hash-new",
            packId: null,
            scope: "user",
            sessionUsages: [
              usage("sess-new", 1, new Date("2026-01-15T00:00:00.000Z")),
            ],
          }),
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    const [row] = result.items;
    expect(row.id).toBe("ac-new");
    expect(row.honestSource).toEqual({
      hasProvenance: true,
      source: "user",
      sourceType: SourceType.Local,
    });
    // …and the LEGACY pair still reads the union, byte-identical to pre-ISS-5009.
    // This is the whole reason the honest projection needs a separate field
    // rather than the union being re-homed onto the representative.
    expect(row.sourceType).toBe(SourceType.Pack);
    expect(row.source).toBe("legacy-pack");
  });
});
