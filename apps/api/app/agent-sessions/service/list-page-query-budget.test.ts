import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import type { AgentSessionListQuery } from "../validators";
import {
  findDbPaginatedPage,
  findDisplayValueSortedPage,
} from "./list-page-fetch";
import { buildAgentSessionOrderBy } from "./query-builder";
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
 * ISS-9556 — the QUERY-COST budget for a Sessions list page.
 *
 * `session-candidate-stream.ts` states the cost this path accepts: ranking on a
 * displayed value no index carries "walks the whole filtered population on every
 * such read". That is affordable only while the walk stays a bounded number of
 * bounded round trips. Nothing pinned that. `list-page-snapshot.test.ts` pins an
 * exact read count, but over a THREE-row population — one chunk — so it cannot
 * distinguish a walk that chunks from one that does not, and
 * `session-candidate-stream.test.ts:146` bounds the chunk count only from below
 * (`toBeGreaterThan(1)`).
 *
 * The budgets below are literals, not derivations of the production constants,
 * so emptying or retuning the module under test reddens them instead of moving
 * them.
 */

/**
 * A representative corpus: several keyset chunks deep, and deliberately NOT a
 * whole multiple of the chunk size, so the walk's final short chunk is the thing
 * that ends it rather than an extra empty round trip.
 */
const POPULATION_ROWS = 12_000;

/** Rows a single keyset round trip may request. */
const CHUNK_ROW_BUDGET = 5000;

/**
 * Database reads one display-sorted page may issue over {@link POPULATION_ROWS}:
 * the `count`, the idle `count`, three keyset chunks (5000 + 5000 + 2000), and
 * one batched hydrate of the page's ids.
 *
 * The number that matters is not 6 — it is that 6 is a function of the CORPUS
 * and nothing else. Per-row hydration (the N+1) makes this `5 + limit`; a count
 * re-issued per chunk makes it 9; abandoning the keyset walk for one unbounded
 * read makes it 4 while blowing {@link CHUNK_ROW_BUDGET}.
 */
const LIST_PAGE_READ_BUDGET = 6;

/**
 * Database reads the COST-sorted page issues over the same population: the two
 * counts, three keyset chunks, one batched hydrate — and, unlike the display
 * sort, one reconciled-cost `$queryRaw` PER CHUNK, because that path resolves
 * its cost authority inside `mapChunk`.
 *
 * Budgeted separately because it is strictly more expensive than the display
 * sort and reached by an ordinary user action (sort by cost, or filter a cost
 * bucket). Holding it to the display sort's 6 would be wrong; leaving it
 * unbudgeted would leave the more expensive path the unmeasured one.
 */
const COST_PAGE_READ_BUDGET = 9;

/**
 * A ceiling on chunk reads that exists only so a non-advancing cursor fails
 * loudly here instead of spinning. Well above the three the budget expects.
 */
const MAX_CHUNK_READS = 16;

/** The three read kinds a display-sorted page issues, as the scope ledger names them. */
const COUNT_READ = "count";
const CHUNK_READ = "keyset chunk";
const HYDRATE_READ = "hydrate";

/**
 * Every read the display-sorted page issues, in order — the two counts, the
 * three keyset chunks, the batched hydrate.
 *
 * whitlockk (#6844): this is the SHAPE of {@link LIST_PAGE_READ_BUDGET}, not just
 * its size, and every entry is a read whose `where` was proven tenant-scoped.
 * The budget alone cannot say that: a read swapped for a different KIND, or a
 * branch that stopped checking scope, keeps the total at 6.
 */
const LIST_PAGE_SCOPED_READS = [
  COUNT_READ,
  COUNT_READ,
  CHUNK_READ,
  CHUNK_READ,
  CHUNK_READ,
  HYDRATE_READ,
];

const ORG_ID = "org-1";
const BASE_WHERE: Prisma.SessionDetailWhereInput = {
  artifact: { is: { organizationId: ORG_ID } },
};
const DURATION_SORT = {
  sortBy: "duration",
  sortDir: "desc",
} as AgentSessionListQuery;
const COST_SORT = {
  sortBy: SESSION_COST_SORT_BY,
  sortDir: "desc",
} as AgentSessionListQuery;

type CandidateRow = {
  artifactId: string;
  sessionStartedAt: Date;
  sessionEndedAt: Date | null;
  awaitingInputSince: Date | null;
  lastActivityAt: Date;
  updatedAt: Date;
  sessionUpdatedAt: Date;
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolUseCount: number;
  billingMode: null;
  artifact: { status: string; organizationId: string };
  user: { firstName: string; lastName: string; email: string };
};

const STARTED_AT = new Date("2026-05-20T17:00:00.000Z");
const ACTIVITY_AT = new Date("2026-05-20T18:00:00.000Z");

function buildRow(index: number): CandidateRow {
  return {
    artifactId: `sess-${String(index).padStart(6, "0")}`,
    sessionStartedAt: STARTED_AT,
    // A distinct end instant per row so the Duration comparator has a real
    // total order to resolve rather than one giant tie settled by the id.
    sessionEndedAt: new Date(STARTED_AT.getTime() + index * 1000),
    awaitingInputSince: null,
    lastActivityAt: ACTIVITY_AT,
    updatedAt: ACTIVITY_AT,
    sessionUpdatedAt: ACTIVITY_AT,
    estimatedCost: index,
    inputTokens: 10,
    outputTokens: 10,
    turns: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolUseCount: 1,
    billingMode: null,
    artifact: { status: "active", organizationId: ORG_ID },
    user: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  };
}

const POPULATION: CandidateRow[] = Array.from(
  { length: POPULATION_ROWS },
  (_unused, index) => buildRow(index)
);

type ChunkRead = { take: number; rows: number };

/**
 * A `sessionDetail` delegate that answers the two reads this path issues, told
 * apart by their `where`: the hydrate re-applies the page's ids as
 * `artifactId: { in: [...] }`, every other `findMany` is a keyset chunk.
 *
 * The chunk branch honors `artifactId: { gt: cursor }` and `take` exactly as
 * Postgres would. That is load-bearing: a delegate that ignored the cursor would
 * serve the same rows forever, so a broken keyset walk would hang here instead
 * of failing an assertion.
 */
function installPopulation() {
  const chunkReads: ChunkRead[] = [];
  const hydrateReads: number[] = [];
  const scopedReads: string[] = [];

  /**
   * Check the tenant predicate AND record that this read was checked. The
   * record is what makes the coverage itself assertable from a test body: a
   * branch that quietly stopped checking leaves a read missing from
   * {@link scopedReads} even with no scope regression present to trip the throw.
   */
  const checkScope = (
    where: Prisma.SessionDetailWhereInput,
    readName: string
  ): void => {
    assertOrgScoped(where, readName);
    scopedReads.push(readName);
  };

  const findMany = vi.fn((args: Record<string, unknown>) => {
    const where = args.where as Prisma.SessionDetailWhereInput;
    const ids = pageIdsOf(where);
    if (ids !== undefined) {
      checkScope(where, HYDRATE_READ);
      hydrateReads.push(ids.length);
      const wanted = new Set(ids);
      return Promise.resolve(
        POPULATION.filter((row) => wanted.has(row.artifactId))
      );
    }
    // whitlockk (#6844): the candidate scan is checked HERE, on the same read that
    // serves it, and not only on the hydrate. A fixture whose every row belongs
    // to one org answers an unscoped candidate scan with exactly the rows a
    // scoped one would return, so without this the scan's `where` is never
    // observed at all and dropping the tenant predicate from it stays green.
    checkScope(where, CHUNK_READ);
    const take = args.take as number;
    const after = cursorOf(args.where as Prisma.SessionDetailWhereInput);
    const start =
      after === undefined
        ? 0
        : POPULATION.findIndex((row) => row.artifactId > after);
    const rows = start < 0 ? [] : POPULATION.slice(start, start + take);
    chunkReads.push({ take, rows: rows.length });
    // A walk that outruns the corpus is a broken cursor, and the honest failure
    // is an assertion — not a suite that hangs until the runner's timeout kills
    // it and reports nothing about which invariant broke.
    if (chunkReads.length > MAX_CHUNK_READS) {
      throw new Error(
        `keyset walk issued more than ${MAX_CHUNK_READS} chunk reads over ${POPULATION_ROWS} rows — the cursor is not advancing`
      );
    }
    return Promise.resolve(rows);
  });

  // The counts publish the list's denominator, so an unscoped one reports
  // another tenant's population as this caller's total. Checked on the same
  // read for the same reason the chunk scan is.
  const count = vi.fn((args: Record<string, unknown>) => {
    checkScope(args.where as Prisma.SessionDetailWhereInput, COUNT_READ);
    return Promise.resolve(POPULATION_ROWS);
  });
  // The cost path resolves its authority through a raw query. Counting it is
  // structural, not incidental: a raw read added to a path that has none today
  // must move that path's budget rather than slip past a `findMany`-only tally.
  const queryRaw = vi.fn().mockResolvedValue([]);

  installDb({
    ...buildAgentSessionDbMock({}),
    sessionDetail: { count, findMany },
    $queryRaw: queryRaw,
  });

  return {
    chunkReads,
    hydrateReads,
    scopedReads,
    reads: () =>
      findMany.mock.calls.length +
      count.mock.calls.length +
      queryRaw.mock.calls.length,
  };
}

/**
 * Every read must carry the caller's tenant predicate — the counts that publish
 * the denominator, every keyset chunk of the candidate scan, and the hydrate. A
 * read that arrives without it has widened tenant scope, which a single-tenant
 * fixture would otherwise serve happily, letting the budget pass over a scope
 * leak.
 */
function assertOrgScoped(
  where: Prisma.SessionDetailWhereInput,
  readName: string
): void {
  if (!carriesOrgPredicate(where)) {
    throw new Error(
      `${readName} read dropped the organization predicate from its where clause`
    );
  }
}

/**
 * The `AND` conjuncts of a `where`, whichever of Prisma's two shapes it used.
 */
function andConjunctsOf(
  where: Prisma.SessionDetailWhereInput
): Prisma.SessionDetailWhereInput[] {
  const and = where.AND;
  if (and === undefined) {
    return [];
  }
  return Array.isArray(and) ? [...and] : [and];
}

/**
 * Does this `where` constrain the read to {@link ORG_ID}?
 *
 * Matched STRUCTURALLY, and only down `AND`. Structurally, because the three
 * reads present the predicate in three different shapes — the counts pass the
 * caller's `where` verbatim, the first keyset chunk passes it verbatim too, and
 * every later chunk and the hydrate AND it against their own clause — so a
 * reference-identity check would have to be written per shape and would go
 * quietly permissive the moment a path rebuilt the object. Only down `AND`,
 * because a predicate reachable through an `OR` does not constrain anything:
 * treating that as scoped would bless exactly the widening this guards.
 */
function carriesOrgPredicate(where: Prisma.SessionDetailWhereInput): boolean {
  const scoped = where.artifact as
    | { is?: { organizationId?: string } }
    | undefined;
  if (scoped?.is?.organizationId === ORG_ID) {
    return true;
  }
  return andConjunctsOf(where).some((conjunct) =>
    carriesOrgPredicate(conjunct)
  );
}

/** The hydrate's id set, when this `where` is the hydrate read. */
function pageIdsOf(
  where: Prisma.SessionDetailWhereInput
): string[] | undefined {
  const conjuncts = Array.isArray(where.AND) ? where.AND : [];
  for (const conjunct of conjuncts) {
    const ids = (conjunct as { artifactId?: { in?: string[] } } | undefined)
      ?.artifactId?.in;
    if (ids !== undefined) {
      return ids;
    }
  }
  return undefined;
}

/**
 * The keyset cursor this chunk resumes from, or undefined for the first.
 *
 * An `artifactId` clause written with any operator OTHER than `gt` is rejected
 * rather than ignored: silently treating it as "no cursor" restarts the walk at
 * the head of the population, which reads as an infinite loop instead of as the
 * contract violation it is.
 */
function cursorOf(where: Prisma.SessionDetailWhereInput): string | undefined {
  const conjuncts = Array.isArray(where.AND) ? where.AND : [];
  const clause = (
    conjuncts[1] as { artifactId?: Record<string, unknown> } | undefined
  )?.artifactId;
  if (clause === undefined) {
    return undefined;
  }
  const operators = Object.keys(clause);
  if (operators.length !== 1 || operators[0] !== "gt") {
    throw new Error(
      `keyset chunk resumed with artifactId operators [${operators.join(", ")}] — the walk must resume strictly after the cursor with \`gt\``
    );
  }
  return clause.gt as string;
}

function readPage(limit: number) {
  return findDisplayValueSortedPage({
    organizationId: ORG_ID,
    where: BASE_WHERE,
    idleWhere: BASE_WHERE,
    offset: 0,
    limit,
    filters: DURATION_SORT,
  });
}

function readCostPage(limit: number) {
  return findDbPaginatedPage({
    organizationId: ORG_ID,
    where: BASE_WHERE,
    idleWhere: BASE_WHERE,
    orderBy: buildAgentSessionOrderBy(COST_SORT),
    offset: 0,
    limit,
  });
}

describe("ISS-9556 — Sessions list query budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues the same bounded number of reads whatever page size is asked for", async () => {
    const small = installPopulation();
    const smallPage = await readPage(25);
    expect(small.reads()).toBe(LIST_PAGE_READ_BUDGET);
    expect(smallPage.items).toHaveLength(25);
    // The page's rows arrive in ONE hydrate, not one read each. This is the
    // assertion an N+1 regression trips first.
    expect(small.hydrateReads).toEqual([25]);

    vi.clearAllMocks();
    const large = installPopulation();
    const largePage = await readPage(100);

    // Four times the page for the same query cost: the walk is sized by the
    // corpus, and the page rides along on the single hydrate.
    expect(large.reads()).toBe(LIST_PAGE_READ_BUDGET);
    expect(largePage.items).toHaveLength(100);
    expect(large.hydrateReads).toEqual([100]);
  });

  it("serves a cost sort on the CHEAPEST budget, with no candidate walk", async () => {
    // ISS-7176 RETIRED COST_PAGE_READ_BUDGET. This case used to assert 9 reads —
    // two counts, three keyset chunks, one hydrate, plus the per-chunk cost
    // authority reads — because the page had to walk candidates and re-derive
    // each session's cost before it could rank them.
    //
    // `estimated_cost` is the displayed figure, so the database ranks and
    // paginates it: the same reads any DB-paginated page issues, no chunk walk,
    // no per-chunk cost read. Asserting the ABSENCE of the chunk reads is the
    // load-bearing half — a regression that reintroduced an in-memory cost pass
    // would keep the page correct and quietly restore the walk.
    const budget = installPopulation();

    const page = await readCostPage(25);

    expect(page.items).toHaveLength(25);
    expect(budget.reads()).toBeLessThan(COST_PAGE_READ_BUDGET);
    // ONE keyset read, and it is the page itself — `take` equals the page size.
    // The old path issued three, walking 10,000 candidates to rank them, plus a
    // per-chunk raw cost read. Asserting the SHAPE rather than only the total is
    // what catches a regression that reintroduced the walk while trimming a read
    // somewhere else to keep the count under the ceiling.
    expect(budget.chunkReads).toEqual([{ take: 25, rows: 25 }]);
    // TWO read kinds, which is fewer than the display-value path's three: the
    // page read IS the rows, so there is no separate hydrate to batch and no
    // per-event cost aggregate — the two reads ISS-7176 deleted from this path.
    expect(new Set(budget.scopedReads)).toEqual(
      new Set([COUNT_READ, CHUNK_READ])
    );
  });

  it("proves every read of the page carried the caller's organization predicate", async () => {
    const budget = installPopulation();

    await readPage(25);

    // whitlockk (#6844): the tenant predicate is verified on the CANDIDATE SCAN and
    // the counts, not on the hydrate alone. A single-tenant fixture answers an
    // unscoped scan with the same rows a scoped one returns, so nothing about
    // the page this suite receives — its length, its order, its read count —
    // can distinguish the two. Only observing each read's own `where` can.
    expect(budget.scopedReads).toEqual(LIST_PAGE_SCOPED_READS);
    // Every read the budget counted is a read that was scope-checked. Ties the
    // coverage to the budget, so a NEW read cannot be added to this path
    // without either carrying the predicate or reddening here.
    expect(budget.scopedReads).toHaveLength(budget.reads());
  });

  it("never reads more than one chunk of rows per round trip, and reads each row once", async () => {
    const budget = installPopulation();

    await readPage(25);

    for (const read of budget.chunkReads) {
      expect(read.take).toBe(CHUNK_ROW_BUDGET);
      expect(read.rows).toBeLessThanOrEqual(CHUNK_ROW_BUDGET);
    }
    // Every candidate row crosses the wire exactly once. A cursor that failed to
    // advance would re-serve the head of the population on every chunk, which is
    // quadratic in the corpus and invisible to an assertion on the returned page.
    const scanned = budget.chunkReads.reduce((sum, read) => sum + read.rows, 0);
    expect(scanned).toBe(POPULATION_ROWS);
    expect(budget.chunkReads).toHaveLength(3);
  });
});
