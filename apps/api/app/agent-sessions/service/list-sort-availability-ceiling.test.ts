import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import type { AgentSessionListQuery } from "../validators";
import { DISPLAY_VALUE_SORTS } from "./session-sort-order";
import { SESSION_COST_SORT_BY } from "./session-sort-rules";

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

/**
 * ISS-6892 — the Sessions list sorts that rank on a DISPLAYED or RECONCILED
 * value (Duration, Owner, Updated, cost, and Status before ISS-9939 /
 * ISS-10262 moved it to the persisted column) used to materialize a bounded
 * 10,000-row prefix of the filtered population and serve the retained length as
 * `total`. Two things followed, and both are asserted here:
 *
 *  1. the list published a memory ceiling as a COMPLETE population denominator,
 *     so past 10,000 it disagreed with the usage summary over the same filter;
 *  2. no page could reach a session ranked past the ceiling.
 *
 * Every fixture below is deliberately ABOVE the ceiling — under it, the capped
 * and uncapped implementations are indistinguishable, so a smaller population
 * would pass either way.
 */
/**
 * Above every bound this suite has ever had to clear.
 *
 * It used to be derived from `SESSION_COST_RECONCILE_CANDIDATE_CAP`, which
 * ISS-7176 deleted along with the reconciled cost path. The number mattered, not
 * the constant: below a ceiling the capped and uncapped implementations are
 * indistinguishable, so a smaller population would pass either way. Kept at the
 * same 10,050 so no case's coverage moves with the rename.
 */
const POPULATION_SIZE = 10_050;
const START = new Date("2026-05-20T17:00:00.000Z");
const UPDATED_BASE = new Date("2026-05-20T18:00:00.000Z");
const SECOND_MS = 1000;

/**
 * Every sort that must publish a TRUE population total, however it is served.
 *
 * The display-value sorts are DERIVED from the module that owns the routing,
 * never restated — `updated` joined `DISPLAY_VALUE_SORTS` after the fact
 * (ISS-6005), and the next column to do so is exactly the change that could
 * re-expose a candidate ceiling.
 *
 * `cost` and `status` are named explicitly rather than derived. Neither ranks
 * in memory any more — cost since ISS-7176, status since ISS-9939 / ISS-10262
 * moved its sort key to the persisted `artifact.status` column — so neither
 * has a candidate ceiling left to re-expose. Both stay in this sweep because
 * the property under test is about the TOTAL a reader is shown, which a
 * DB-paginated sort has to get right just as much — and because a future
 * change that routed either back through a bounded scan would otherwise land
 * with no case covering it.
 */
type SessionSortBy = NonNullable<AgentSessionListQuery["sortBy"]>;
const CEILINGED_SORTS: SessionSortBy[] = [
  ...[...DISPLAY_VALUE_SORTS].filter(
    (sortBy): sortBy is SessionSortBy => sortBy !== undefined
  ),
  SESSION_COST_SORT_BY,
  "status",
];

type PopulationRow = ReturnType<typeof buildCandidate>;

/**
 * One synthetic candidate. Every ranked dimension is keyed off `index` so a
 * row's rank under a given sort is its index (ascending) — which is what lets a
 * test name the row it expects at a rank BEYOND the old ceiling.
 */
function buildCandidate(index: number) {
  const id = `s-${String(index).padStart(5, "0")}`;
  const endedAt = new Date(START.getTime() + (index + 1) * SECOND_MS);
  return {
    artifactId: id,
    sessionStartedAt: START,
    sessionEndedAt: endedAt,
    awaitingInputSince: null,
    lastActivityAt: endedAt,
    updatedAt: new Date(UPDATED_BASE.getTime() + index * SECOND_MS),
    sessionUpdatedAt: new Date(UPDATED_BASE.getTime() + index * SECOND_MS),
    // Cost DESC ranks by index too: the most expensive session is index 0.
    estimatedCost: POPULATION_SIZE - index,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 1,
    toolUseCount: 1,
    billingMode: null,
    artifact: {
      status: SESSION_STATUS.INACTIVE,
      updatedAt: new Date(UPDATED_BASE.getTime() + index * SECOND_MS),
      // ISS-12251 D-1: the Owner sort reads the artifact's assignee.
      assignee: {
        firstName: "Owner",
        lastName: String(index).padStart(5, "0"),
        email: `${id}@example.com`,
      },
    },
  };
}

const population: PopulationRow[] = Array.from(
  { length: POPULATION_SIZE },
  (_unused, index) => buildCandidate(index)
);

/**
 * A fake `sessionDetail` whose row set has ONE size. The list resolves its
 * `total` through `count`, the usage summary through `aggregate._count._all`;
 * both are derived from `population.length` here, so the two read paths describe
 * the same data and any divergence between them is the implementation's.
 *
 * `findMany` honors `take` and the keyset `artifactId > cursor` clause the same
 * way Postgres does, so a capped single-shot scan and a chunked walk produce
 * genuinely different candidate sets against it.
 */
function installPopulationDb() {
  const findMany = vi.fn().mockImplementation((args: FindManyArgs) => {
    const idClause = Array.isArray(args.where?.AND)
      ? (args.where.AND[1] as KeysetClause | undefined)
      : undefined;
    const hydrateIds = idClause?.artifactId?.in;
    if (hydrateIds) {
      return Promise.resolve(
        hydrateIds.map((id) => buildSessionListRecord({ artifactId: id }))
      );
    }
    // ISS-7176: a cost sort is DB-paginated now, so its page read asks for the
    // FULL list select rather than the candidate columns — and `computeTarget`
    // is the part the projection dereferences. Served before the candidate
    // branch because the full select also carries `awaitingInputSince`, so
    // ordering these the other way hands the page candidate-shaped rows and the
    // projection fails on a missing relation rather than on a wrong order.
    if (args.select?.computeTarget) {
      // OFFSET, not a keyset cursor — the DB-paginated path pages with
      // `skip`/`take`, which is the whole reason it needs no candidate walk.
      // Serving it from index 0 regardless of `skip` would make every
      // rank-beyond-the-ceiling case pass on row one.
      //
      // The population is built index-ascending with cost DESCENDING (index 0 is
      // the most expensive), so for this suite's `sortDir: "desc"` the natural
      // order already is the requested one; no reordering is modelled here.
      const skip = args.skip ?? 0;
      return Promise.resolve(
        population
          .slice(skip, skip + (args.take ?? population.length))
          .map((row) => buildSessionListRecord({ artifactId: row.artifactId }))
      );
    }
    // Only the candidate scan selects the in-memory comparators' columns; any
    // other read on this model (the attribution lenses) gets no rows.
    if (args.select?.awaitingInputSince !== true) {
      return Promise.resolve([]);
    }
    const after = idClause?.artifactId?.gt;
    const start =
      after === undefined
        ? 0
        : population.findIndex((row) => row.artifactId > after);
    if (start < 0) {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      population.slice(start, start + (args.take ?? population.length))
    );
  });
  installDb({
    sessionDetail: buildAgentSessionDbMock({
      findMany,
      count: vi
        .fn()
        .mockImplementation((args: { take?: number }) =>
          Promise.resolve(
            Math.min(population.length, args.take ?? population.length)
          )
        ),
      aggregate: vi.fn().mockResolvedValue({
        _count: { _all: population.length },
        _sum: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCost: 0,
        },
        _min: { sessionStartedAt: START },
        _max: { sessionStartedAt: START },
      }),
      groupBy: vi.fn().mockResolvedValue([]),
    }),
    agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
    computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    loop: { findMany: vi.fn().mockResolvedValue([]) },
  });
  return findMany;
}

type KeysetClause = { artifactId?: { in?: string[]; gt?: string } };
type FindManyArgs = {
  where?: { AND?: unknown[] };
  select?: { awaitingInputSince?: boolean; computeTarget?: unknown };
  take?: number;
  skip?: number;
};

describe("Sessions list sort availability ceiling (ISS-6892)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const sortBy of CEILINGED_SORTS) {
    it(`reconciles list total with the summary count over the same filter — sortBy=${sortBy}`, async () => {
      installPopulationDb();
      const filters = { quality: "all" } as const;

      const [page, summary] = await Promise.all([
        agentSessionsService.findSessions({
          organizationId: "org-1",
          filters: { ...filters, sortBy, sortDir: "asc" },
        }),
        agentSessionsService.getUsageSummary({
          organizationId: "org-1",
          filters,
        }),
      ]);

      // The load-bearing assertion: the two denominators are compared to EACH
      // OTHER on one population, not each to a constant. Asserting them
      // independently is exactly what let them drift.
      expect(page.total).toBe(summary.totalSessions);
      // …and neither is the ceiling. Pinning the value too catches a fix that
      // makes them agree by capping the SUMMARY instead of freeing the list.
      expect(page.total).toBe(POPULATION_SIZE);
      expect(page.total).toBeGreaterThan(10_000);
    });
  }

  it("serves a session ranked BEYOND the ceiling on a duration sort", async () => {
    installPopulationDb();
    const rank = POPULATION_SIZE - 30;

    const page = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        sortBy: "duration",
        sortDir: "asc",
        quality: "all",
        limit: 1,
        offset: rank,
      },
    });

    // Duration ascending ranks by index, so rank N is `s-0000N` — a row the
    // capped scan never materialized and no offset could reach.
    expect(page.items.map((item) => item.id)).toEqual([`s-${rank}`]);
  });

  it("serves a session ranked BEYOND the ceiling on a cost sort", async () => {
    installPopulationDb();
    const rank = POPULATION_SIZE - 20;

    const page = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        sortBy: "cost",
        sortDir: "desc",
        quality: "all",
        limit: 1,
        offset: rank,
      },
    });

    // Cost descending ranks by index too (index 0 is the most expensive).
    expect(page.items.map((item) => item.id)).toEqual([`s-${rank}`]);
  });

  it("serves a session ranked BEYOND the ceiling on an owner sort", async () => {
    installPopulationDb();
    const rank = POPULATION_SIZE - 25;

    const page = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        sortBy: "user",
        sortDir: "asc",
        quality: "all",
        limit: 1,
        offset: rank,
      },
    });

    // The owner display name is `Owner <zero-padded index>`, so ascending by
    // the rendered name ranks by index.
    expect(page.items.map((item) => item.id)).toEqual([`s-${rank}`]);
  });

  it("pages the ceiling boundary contiguously, with no skipped or repeated row", async () => {
    installPopulationDb();
    const before = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        sortBy: "updated",
        sortDir: "asc",
        quality: "all",
        limit: 2,
        offset: 10_000 - 2,
      },
    });
    const across = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        sortBy: "updated",
        sortDir: "asc",
        quality: "all",
        limit: 2,
        offset: 10_000,
      },
    });

    expect(before.items.map((item) => item.id)).toEqual(["s-09998", "s-09999"]);
    // The page that used to be the first fully-unreachable one.
    expect(across.items.map((item) => item.id)).toEqual(["s-10000", "s-10001"]);
  });

  it("scans the population in bounded chunks rather than one whole-history read", async () => {
    const findMany = installPopulationDb();

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "user", sortDir: "asc", quality: "all", limit: 5 },
    });

    const candidateScans = findMany.mock.calls.filter((call) => {
      const args = call[0] as FindManyArgs;
      const idClause = Array.isArray(args.where?.AND)
        ? (args.where.AND[1] as KeysetClause | undefined)
        : undefined;
      // The page hydrate reads the same model; it is identified by its id set.
      return (
        args.select?.awaitingInputSince === true &&
        idClause?.artifactId?.in === undefined
      );
    });
    // Removing the ceiling must not mean reading the whole population in one
    // shot: every chunk is bounded, and it takes more than one to cover a
    // population this size.
    expect(candidateScans.length).toBeGreaterThan(1);
    for (const call of candidateScans) {
      const take = (call[0] as FindManyArgs).take ?? Number.POSITIVE_INFINITY;
      expect(take).toBeLessThan(10_000);
    }
  });
});
