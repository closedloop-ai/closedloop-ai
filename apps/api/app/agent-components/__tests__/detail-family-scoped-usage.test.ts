/**
 * ISS-10341 regression suite: ONE POPULATION PER PAGE. Every aggregate the
 * agent-component detail produces sums the component FAMILY, so a content-hash
 * route and a legacy name route for the same component report the same numbers.
 *
 * The observed defect (on the `frankenstein` skill) was `invocations: 0` /
 * `sessions: 0` beside 36 matched invocation rows, while the list row at the
 * very same href reported 74/15. Neither surface was double-counting and every
 * ISS-5363 lane issued its read: 32 of the identity's 36 usage rows carried
 * NEITHER `componentVersionHash` NOR a `definitionVersionId`, and FEA-4335
 * narrowed these lanes to the requested byte-version, which no such row can
 * satisfy. The list collapses the FAMILY (FEA-4267) and links it at the
 * canonical VERSION's routable key, so the two surfaces were answering different
 * questions at one URL. Marisol Ashgrove's ruling: `${kind}::${fingerprint}`
 * addresses the family; a version narrows only inside an explicit drill-down.
 *
 * The scope of that is wider than the two counts, which is why the cases below
 * assert the session-id SPINE and not just the totals. `loadSessionLocCost` and
 * `computeCohortPerformance` are both fed the set these lanes produce, so the
 * narrowing did not merely understate LOC/$, cohort performance, token
 * efficiency, merged PRs and the efficiency trend — it emptied them. Measured on
 * production before the fix: the name route carried `successRate 100`,
 * `tokenEfficiencyDelta 74`, `mergedPrs 576` and an 8-point `efficiencyTrend`,
 * and the content-hash route carried `null` for every one of them.
 *
 * The doubles EVALUATE the emitted predicates against ONE declared usage row
 * set. That is load-bearing: a double that ignored the content scope would have
 * returned the same rows to the pre-fix code and let this pass against the bug.
 *
 * The reconciliation is asserted DIRECTLY — one row set, both routes, `hash ===
 * name` — rather than by pinning two independent constants, which drift the
 * moment either derivation moves. The sibling ISS-5363 suite
 * (`detail-list-usage-reconciliation.test.ts`) states the same rule for the
 * detail⇄list pair.
 */

import { AgentComponentInvocationAttributionStatus } from "@repo/api/src/types/agent-component-invocation";
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

import {
  buildInventoryRow,
  buildServiceDb,
} from "@/__tests__/support/agent-components/service-db-double";
import { agentComponentsService } from "../service";

const ORG = "org-iss-10341";
const KIND = "skill";
const KEY = "frankenstein";
const INVENTORY_ID = "ac-frankenstein";
/** The fingerprint the list links this family at — its canonical version. */
const FINGERPRINT = "d".repeat(64);
/** A DIFFERENT byte-version of the same name, same family. */
const OTHER_HASH = "e".repeat(64);
const CONTENT_HASH_SLUG = `${KIND}::${FINGERPRINT}`;
const NAME_SLUG = `${KIND}::${KEY}`;
/** The matched invocation ledger rows the reported payload carried. */
const MATCHED_INVOCATION_ROWS = 36;

/** One `AgentComponentSessionUsage` row as every lane sees it. */
type UsageFixture = {
  id: string;
  agentSessionId: string;
  invocationCount: number;
  /** The coarse hash-at-invocation. `null` ⇒ the row names no version. */
  componentVersionHash: string | null;
  /** The F1 link. `null` ⇒ the row names no version by that route either. */
  definitionVersionId: string | null;
};

function usageRow(overrides: Partial<UsageFixture> = {}): UsageFixture {
  return {
    id: "u-1",
    agentSessionId: "sess-1",
    invocationCount: 1,
    componentVersionHash: null,
    definitionVersionId: null,
    ...overrides,
  };
}

/**
 * The declared population: the reported shape, with the two rows that DO name a
 * version kept distinct so a surviving content narrowing shows up as a specific
 * wrong subtotal rather than an empty read.
 */
const FAMILY_USAGE: readonly UsageFixture[] = [
  usageRow({ id: "u-bare-a", agentSessionId: "sess-1", invocationCount: 40 }),
  usageRow({ id: "u-bare-b", agentSessionId: "sess-2", invocationCount: 29 }),
  usageRow({
    id: "u-this-version",
    agentSessionId: "sess-3",
    invocationCount: 4,
    componentVersionHash: FINGERPRINT,
  }),
  usageRow({
    id: "u-other-version",
    agentSessionId: "sess-4",
    invocationCount: 1,
    componentVersionHash: OTHER_HASH,
  }),
];
const FAMILY_INVOCATIONS = 74;
const FAMILY_SESSIONS = 4;

/**
 * `usageContentScopeWhere`'s two arms, evaluated honestly, so a predicate that
 * still narrows by content version drops exactly the rows it would in SQL. Arm
 * two is the F1 link, which only a row carrying a `definitionVersionId` can
 * satisfy; a row with neither arm satisfies nothing, which is the defect.
 */
function passesContentScope(
  where: Record<string, unknown>,
  row: UsageFixture
): boolean {
  const arms = where.OR as
    | {
        componentVersionHash?: { in?: string[] };
        definitionVersion?: unknown;
      }[]
    | undefined;
  if (!arms) {
    return true;
  }
  return arms.some((arm) => {
    if (arm.componentVersionHash?.in) {
      return (
        row.componentVersionHash !== null &&
        arm.componentVersionHash.in.includes(row.componentVersionHash)
      );
    }
    if (arm.definitionVersion) {
      return row.definitionVersionId !== null;
    }
    return false;
  });
}

/** The FK-lane `groupBy`, over the rows the emitted predicate actually admits. */
function usageGroupBy(rows: readonly UsageFixture[]) {
  return vi.fn((args: { where?: Record<string, unknown> }) => {
    const where = args.where ?? {};
    const fkIds = (where.agentComponentId as { in?: string[] } | undefined)?.in;
    const admitted = rows.filter(
      (row) =>
        (!fkIds || fkIds.includes(INVENTORY_ID)) &&
        passesContentScope(where, row)
    );
    return Promise.resolve(
      admitted.map((row) => ({
        agentComponentId: INVENTORY_ID,
        agentSessionId: row.agentSessionId,
        gitBranch: "",
        harness: null,
        componentKind: KIND,
        componentKey: KEY,
        componentVersionHash: row.componentVersionHash,
        definitionVersionId: row.definitionVersionId,
        _sum: { invocationCount: row.invocationCount, errorCount: 0 },
        _max: { lastInvokedAt: null },
      }))
    );
  });
}

function installDb(rows: readonly UsageFixture[] = FAMILY_USAGE) {
  const db = buildServiceDb({
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([
        buildInventoryRow({
          id: INVENTORY_ID,
          organizationId: ORG,
          componentKind: KIND,
          componentKey: KEY,
          name: KEY,
          contentHash: FINGERPRINT,
        }),
      ]),
    },
    agentComponentVersion: {
      findMany: vi.fn((args: { where?: Record<string, unknown> }) => {
        // The EXACT (`definitionVersion.definitionHash`) resolution finds
        // nothing, so the route resolves through the coarse `contentHash`
        // fallback — the shape `resolveContentHashIdentity` documents.
        if (args.where?.definitionVersion) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          { componentKey: KEY, contentHash: FINGERPRINT },
        ]);
      }),
    },
    agentComponentInvocation: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([
        {
          attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
          _count: { _all: MATCHED_INVOCATION_ROWS },
        },
      ]),
    },
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: usageGroupBy(rows),
    },
  });
  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
  mocks.withDb.tx.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
  return db;
}

/** Every session id the LOC/cost lane was actually asked about. */
function locCostSessionIds(db: Record<string, unknown>): string[] {
  const delegate = db.sessionDetail as {
    findMany: { mock: { calls: [{ where?: Record<string, unknown> }][] } };
  };
  const seen = new Set<string>();
  for (const [args] of delegate.findMany.mock.calls) {
    // `SessionDetail` keys on the parent artifact id, which IS the session id
    // this lane is handed (`loadSessionLocCost`).
    const ids = (args.where?.artifactId as { in?: string[] } | undefined)?.in;
    for (const id of ids ?? []) {
      seen.add(id);
    }
  }
  return [...seen].sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listByArtifactIds.mockResolvedValue([]);
});

describe("agent-component detail — one population per page (ISS-10341)", () => {
  it("reports the family total on a content-hash route, not a measured 0", async () => {
    installDb();

    const detail = await agentComponentsService.getDetailForOrg(
      ORG,
      CONTENT_HASH_SLUG
    );

    expect(detail?.invocations).toBe(FAMILY_INVOCATIONS);
    expect(detail?.sessions).toBe(FAMILY_SESSIONS);
    // The payload half that was always right, still right beside them.
    expect(detail?.invocationRows?.total).toBe(MATCHED_INVOCATION_ROWS);
    expect(detail?.invocationRows?.unmatchedCount).toBe(0);
  });

  it("makes the content-hash and name routes agree, row set for row set", async () => {
    installDb();
    const byHash = await agentComponentsService.getDetailForOrg(
      ORG,
      CONTENT_HASH_SLUG
    );

    installDb();
    const byName = await agentComponentsService.getDetailForOrg(ORG, NAME_SLUG);

    expect(byHash?.invocations).toBe(byName?.invocations);
    expect(byHash?.sessions).toBe(byName?.sessions);
    expect(byHash?.usageSessions?.length).toBe(byName?.usageSessions?.length);
  });

  it("counts a SIBLING byte-version's usage — the family includes it", async () => {
    // The FEA-4335 reversal, stated so it cannot be undone silently: the row
    // carrying OTHER_HASH is this family's, and the family is the population.
    installDb();

    const detail = await agentComponentsService.getDetailForOrg(
      ORG,
      CONTENT_HASH_SLUG
    );

    expect(detail?.usageSessions?.map((s) => s.sessionId).sort()).toEqual([
      "sess-1",
      "sess-2",
      "sess-3",
      "sess-4",
    ]);
  });

  it("hands the FULL family session set to the LOC/cost lane", async () => {
    // The spine, not a second derivation: `loadSessionLocCost` and
    // `computeCohortPerformance` both read this set, so a narrowed population
    // empties LOC/$, cohort performance, token efficiency, merged PRs and the
    // efficiency trend rather than merely understating them.
    const db = installDb();

    await agentComponentsService.getDetailForOrg(ORG, CONTENT_HASH_SLUG);

    expect(locCostSessionIds(db)).toEqual([
      "sess-1",
      "sess-2",
      "sess-3",
      "sess-4",
    ]);
  });

  it("asks its usage lanes no content-version question at all", async () => {
    // The narrowing is gone at the source rather than compensated downstream —
    // so no lane can reintroduce it for one aggregate and not another.
    const db = installDb();

    await agentComponentsService.getDetailForOrg(ORG, CONTENT_HASH_SLUG);

    const groupBy = (
      db.agentComponentSessionUsage as {
        groupBy: { mock: { calls: [{ where?: Record<string, unknown> }][] } };
      }
    ).groupBy;
    for (const [args] of groupBy.mock.calls) {
      expect(JSON.stringify(args.where ?? {})).not.toContain(FINGERPRINT);
    }
  });

  it("still returns nothing for a fingerprint that is nobody's family", async () => {
    // Family scoping widens the population of a REAL identity; it must not turn
    // an unknown fingerprint into a match on some other component's usage.
    const db = buildServiceDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
        // The ambiguous-64-hex NAME fallback this route falls through to.
        findFirst: vi.fn().mockResolvedValue(null),
      },
      agentComponentVersion: { findMany: vi.fn().mockResolvedValue([]) },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([]),
        groupBy: vi.fn().mockResolvedValue([]),
      },
    });
    mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
    mocks.withDb.tx.mockImplementation((cb: (db: unknown) => unknown) =>
      cb(db)
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORG,
      `${KIND}::${OTHER_HASH}`
    );

    expect(detail).toBeNull();
  });
});
