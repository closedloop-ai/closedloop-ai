/**
 * ISS-9114 finding 3 — `loadSessionLocCost` and `computeCohortPerformance` read
 * the same session-id scope, and ISS-9114 issues them CONCURRENTLY rather than
 * in turn.
 *
 * The point of these tests is what the change must NOT do. The two reads look
 * collapsible — the LOC/cost projection is a strict column subset of
 * `COHORT_SESSION_SELECT` — but they are not the same population and not the
 * same failure domain:
 *
 *   - `computeCohortPerformance` slices the cohort to its own scan cap;
 *     `loadSessionLocCost` folds the FULL id set in chunks, because a dropped
 *     chunk silently understates LOC/$ rather than failing.
 *   - `loadSessionLocCost` is fail-open enrichment (empty map on error); the
 *     cohort read is not.
 *
 * A collapse onto the capped cohort read would emit a plausible, wrong
 * `locPerDollar` with no error anywhere. The first test below is the one that
 * fails if that ever happens.
 *
 * The batching assertion is a peak in-flight count (the shape
 * `detail-read-orphan-parallel.test.ts` uses), never a wall-clock one —
 * `scripts/lint/rules/no-timing-assertions.ts` gates that.
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type PrismaOrderBy, sortByPrismaOrderBy } from "./prisma-order-double";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ values }),
    // The detail read's three usage lanes share one `withDb.tx` snapshot.
    TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" },
  },
  listByArtifactIds: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  Prisma: mocks.Prisma,
  withDb: mocks.withDb,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import { packAnalyticsService } from "../pack-analytics-service";
import { agentComponentsService } from "../service";

const ORGANIZATION_ID = "org-1";
const PACK_ID = "pack-1";
const CHILD_KEY = "child-a";
const CHILD_KIND = "command";

/**
 * More sessions than the retired cohort scan cap, so a cohort read that went
 * back to bounding its own population would provably disagree with the LOC
 * fold. Written out here rather than imported from a production constant: a
 * test that reads its expectation from the constant it polices cannot notice
 * that constant moving out from under either lane.
 */
const SESSION_COUNT = 2001;

/** The cohort walk's chunk size (ISS-9627), pinned independently of production. */
const COHORT_CHUNK_SIZE = 5000;

/** The LOC/cost bind-parameter chunk size, pinned independently of production. */
const LOC_COST_CHUNK_SIZE = 1000;

/**
 * Peak concurrent in-flight queries the batched block reaches under this
 * fixture: the cohort read (1) overlapping the first LOC/cost chunk (1).
 *
 * The floor is what makes the regression fail: awaiting the two lanes in turn
 * peaks at 1, because every query inside each lane is itself sequential here.
 */
const BATCHED_PEAK_IN_FLIGHT = 2;

function sessionId(index: number): string {
  return `session-${String(index).padStart(6, "0")}`;
}

const SESSION_IDS = Array.from({ length: SESSION_COUNT }, (_, i) =>
  sessionId(i + 1)
);

/**
 * The child-usage row's PRIMARY KEY is part of the fixture, not decoration.
 * `loadChildUsageByPackId` reads the prefilter in bind-bounded slices whose FK
 * and identity lanes overlap by construction, so it merges them through a
 * `Map` keyed on `id`. A fixture row without one keys every row on `undefined`,
 * collapsing 2001 sessions to the LAST row — which is not a smaller cohort but
 * a DIFFERENT one, so the population split these tests exist to police is never
 * exercised and the failure reads as an unrelated count mismatch.
 */
function childUsageRow(agentSessionId: string) {
  return {
    id: `usage-${agentSessionId}`,
    agentSessionId,
    componentKind: CHILD_KIND,
    componentKey: CHILD_KEY,
    invocationCount: 1,
    errorCount: 0,
    lastInvokedAt: null,
  };
}

function cohortSessionRow(artifactId: string) {
  return {
    artifactId,
    linesAdded: 10,
    linesRemoved: 0,
    locSource: null,
    repositoryFullName: null,
    estimatedCost: 1,
    inputTokens: 0,
    outputTokens: 0,
    sessionStartedAt: new Date("2026-02-01T00:00:00.000Z"),
    artifact: { sourceLinks: [] },
  };
}

type SessionFindManyArgs = {
  where: { artifactId?: { in?: string[]; notIn?: string[] } };
  select?: { artifact?: unknown };
  take?: number;
};

/**
 * True for a cohort chunk read — it joins the PR-link graph AND names the ids
 * it wants. ISS-9853: the baseline comparator sample shares that projection and
 * now RUNS on this fixture (a large cohort no longer loses its window), so the
 * `in` list is what still separates the two; the baseline excludes by `notIn`.
 */
function isCohortRead(args: SessionFindManyArgs): boolean {
  return (
    Boolean(args.select?.artifact) && args.where.artifactId?.in !== undefined
  );
}

type LaneProbe = {
  /** `where.artifactId.in` of every LOC/cost chunk, in issue order. */
  locCostChunks: string[][];
  /** `where.artifactId.in` of every cohort read. */
  cohortScans: string[][];
  /**
   * Peak simultaneous in-flight queries OF THE TWO LANES — `sessionDetail`
   * reads only, never every delegate the caller happens to touch.
   *
   * Counting all delegates cannot fail on the detail path: `getDetailForOrg`
   * runs an unrelated `Promise.all` (version history + invocation rows) that
   * reaches a peak of 2 on its own, so a serialized LOC/cohort pair still
   * looked batched. Scoped to the lanes, a peak of 2 is reachable only when a
   * LOC/cost chunk and the cohort scan are genuinely overlapping.
   */
  peakInFlight: number;
};

type DbOverrides = {
  /** Reject the LOC/cost lane's query (the fail-open half). */
  failLocCost?: boolean;
  /** Reject the cohort lane's query (the half that must NOT be absorbed). */
  failCohort?: boolean;
};

/**
 * One probe plus the delegate wrapper that feeds it. Shared by both entry
 * points below so the pack path and the detail path observe the same lane
 * split — the two probes are of ONE contract, not two.
 */
function createLaneTracker() {
  const probe: LaneProbe = {
    locCostChunks: [],
    cohortScans: [],
    peakInFlight: 0,
  };
  let laneInFlight = 0;

  // Holds its slot across one microtask, so queries issued in the same tick
  // overlap and queries issued in turn never do.
  const suspended = <TArgs, TResult>(
    resolve: (args: TArgs) => TResult,
    onEnter?: () => void,
    onExit?: () => void
  ) =>
    vi.fn(async (args: TArgs): Promise<TResult> => {
      onEnter?.();
      await Promise.resolve();
      onExit?.();
      return resolve(args);
    });

  /** A delegate outside the two lanes: observed, but not counted as lane work. */
  const tracked = <TArgs, TResult>(resolve: (args: TArgs) => TResult) =>
    suspended(resolve);

  /** Record and answer one `sessionDetail.findMany`, honoring the overrides. */
  const sessionDetailFindMany = (overrides: DbOverrides) =>
    suspended(
      (args: SessionFindManyArgs) => {
        const ids = args.where.artifactId?.in ?? [];
        if (args.where.artifactId?.notIn !== undefined) {
          // The baseline comparator sample — neither lane this suite polices,
          // and only reachable at all since ISS-9853 stopped nulling the window
          // for a large cohort.
          return [];
        }
        if (isCohortRead(args)) {
          probe.cohortScans.push(ids);
          if (overrides.failCohort) {
            throw new Error("cohort read failed");
          }
          return ids.map(cohortSessionRow);
        }
        probe.locCostChunks.push(ids);
        if (overrides.failLocCost) {
          throw new Error("loc/cost read failed");
        }
        return ids.map(cohortSessionRow);
      },
      () => {
        laneInFlight += 1;
        probe.peakInFlight = Math.max(probe.peakInFlight, laneInFlight);
      },
      () => {
        laneInFlight -= 1;
      }
    );

  /**
   * A tracked `findMany` that honors the query's own `orderBy` instead of the
   * fixture's insertion order, so a read whose ordering matters is proven by
   * the query (the shape `detail-installer-roster.test.ts` uses).
   */
  const sortedTracked = <TRow extends Record<string, unknown>>(rows: TRow[]) =>
    tracked((args?: { orderBy?: PrismaOrderBy }) =>
      sortByPrismaOrderBy(rows, args?.orderBy)
    );

  return { probe, tracked, sortedTracked, sessionDetailFindMany };
}

function installDb(overrides: DbOverrides = {}): LaneProbe {
  const { probe, tracked, sessionDetailFindMany } = createLaneTracker();

  const db = {
    agentComponentSessionUsage: {
      findMany: tracked(() => SESSION_IDS.map(childUsageRow)),
    },
    agentComponent: {
      findMany: tracked((args?: { where?: unknown; orderBy?: PrismaOrderBy }) =>
        sortByPrismaOrderBy(
          (args?.where as { componentKind?: unknown } | undefined)
            ?.componentKind
            ? [
                {
                  componentKind: CHILD_KIND,
                  componentKey: CHILD_KEY,
                  packId: PACK_ID,
                },
              ]
            : [],
          args?.orderBy
        )
      ),
    },
    user: { findMany: tracked(() => []) },
    artifactLink: { findMany: tracked(() => []) },
    sessionDetail: {
      findMany: sessionDetailFindMany(overrides),
      // ISS-9853: the baseline lane RUNS on this fixture now (a cohort no
      // longer loses its window for exceeding a cap), so the double answers the
      // coverage counters production reads off the same statement as the `_sum`.
      aggregate: tracked(() => ({
        _sum: {
          estimatedCost: null,
          inputTokens: null,
          outputTokens: null,
          linesAdded: null,
          linesRemoved: null,
        },
        _count: { _all: 0, estimatedCost: 0 },
        _min: { estimatedCost: null },
      })),
      groupBy: tracked(() => []),
    },
    $queryRaw: tracked(() => [{ unkeyableLoc: 0n, keyedLocs: [] }]),
  };

  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  return probe;
}

describe("ISS-9114 cohort scope batching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("folds LOC/cost and walks the cohort over the FULL session set, in separate lanes", async () => {
    const probe = installDb();

    await packAnalyticsService.getPackAnalytics(ORGANIZATION_ID, PACK_ID);

    // ISS-9853: this asserted the cohort lane stopped at 2,000 ids. The
    // EXPECTATION changed — that bound published a prefix as the population
    // (PRD-666) — so the cohort lane covers every id too, in chunks. What must
    // NOT change is that it stays its own lane: collapsing it onto the LOC read
    // would put the fail-open fold on a fatal path.
    const coverage = cohortWalkCoverage(probe);
    expect(coverage.ids).toHaveLength(SESSION_COUNT);
    expect(coverage.distinctIds).toBe(SESSION_COUNT);
    expect(coverage.chunks).toBe(EXPECTED_COHORT_CHUNKS);

    // The LOC lane chunks on a different (bind-parameter) boundary and covers
    // every id; truncating it here would understate LOC/$ with no error raised.
    const foldedIds = new Set(probe.locCostChunks.flat());
    expect(foldedIds.size).toBe(SESSION_COUNT);
    expect(probe.locCostChunks).toHaveLength(
      Math.ceil(SESSION_COUNT / LOC_COST_CHUNK_SIZE)
    );
    for (const id of SESSION_IDS) {
      expect(foldedIds.has(id)).toBe(true);
    }
  });

  it("issues the LOC/cost and cohort reads concurrently, not in turn", async () => {
    const probe = installDb();

    const result = await packAnalyticsService.getPackAnalytics(
      ORGANIZATION_ID,
      PACK_ID
    );

    expect(result).not.toBeNull();
    expect(probe.peakInFlight).toBeGreaterThanOrEqual(BATCHED_PEAK_IN_FLIGHT);
  });

  it("absorbs a LOC/cost failure but not a cohort failure", async () => {
    installDb({ failLocCost: true });

    const degraded = await packAnalyticsService.getPackAnalytics(
      ORGANIZATION_ID,
      PACK_ID
    );

    // Fail-open: the response is still served, and the cohort half is real.
    expect(degraded).not.toBeNull();
    // ISS-9853: `loadChildUsageByPackId` carries no `take`, so the pack's id set
    // IS its cohort and the producer attests so — where the retired cap made
    // this `true` purely because the cohort held more than 2,000 sessions.
    expect(degraded?.mergedPrsTruncated).toBe(false);
    expect(degraded?.sessions).toBe(SESSION_COUNT);

    installDb({ failCohort: true });

    await expect(
      packAnalyticsService.getPackAnalytics(ORGANIZATION_ID, PACK_ID)
    ).rejects.toThrow("cohort read failed");
  });
});

// ---------------------------------------------------------------------------
// The same contract through `getDetailForOrg` (whitlockk review on #6605). The pack
// overlay and the component detail are two independent call sites of the same
// pair of reads — `detail-read.ts` batches them itself rather than delegating to
// `pack-analytics-service.ts` — so proving the population split and the failure
// asymmetry on one says nothing about the other.
// ---------------------------------------------------------------------------

const COMPONENT_KEY = "my-skill";
const DETAIL_SLUG = encodeComponentSlug(
  AgentComponentKind.Skill,
  COMPONENT_KEY,
  null
);
const INVENTORY_ID = "ac-1";

/** One live inventory row, so the read takes the inventory arm, not orphan-only. */
function inventoryRow() {
  return {
    id: INVENTORY_ID,
    organizationId: ORGANIZATION_ID,
    computeTargetId: "target-1",
    componentKind: AgentComponentKind.Skill,
    componentKey: COMPONENT_KEY,
    externalComponentId: `skill::${COMPONENT_KEY}`,
    harness: "claude",
    name: "My Skill",
    sourceUrl: null,
    installPath: null,
    packId: null,
    scope: null,
    projectPath: null,
    description: null,
    metadata: null,
    content: "BODY",
    contentHash: null,
    resolvedState: "resolved",
    variantsTruncated: false,
    variantsTruncatedReason: null,
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-01-10T00:00:00.000Z"),
    computeTarget: { id: "target-1", userId: "user-1" },
  };
}

/**
 * Orphan usage is the lane that puts every session in `effectiveSessionIdSet`
 * without an FK-linked inventory row per session — the cheapest fixture that
 * drives the detail past the cohort scan cap.
 */
function orphanUsageRow(agentSessionId: string) {
  return {
    agentSessionId,
    invocationCount: 1,
    harness: "claude",
    gitBranch: "",
    definitionVersionId: null,
    firstInvokedAt: null,
    lastInvokedAt: null,
  };
}

function installDetailDb(overrides: DbOverrides = {}): LaneProbe {
  const { probe, tracked, sortedTracked, sessionDetailFindMany } =
    createLaneTracker();

  const db = {
    agentComponent: {
      // Serves all three inventory reads: the detail's own roster read, the
      // family's live ids inside the usage snapshot, and the org population.
      findMany: sortedTracked([inventoryRow()]),
      groupBy: tracked(() => []),
    },
    agentComponentVersion: { findMany: tracked(() => []) },
    agentComponentSessionUsage: {
      findMany: tracked(() => SESSION_IDS.map(orphanUsageRow)),
      groupBy: tracked(() => []),
    },
    agentComponentInvocation: {
      findMany: tracked(() => []),
      groupBy: tracked(() => []),
    },
    artifactLink: { findMany: tracked(() => []) },
    definitionVersion: { findMany: tracked(() => []) },
    definitionVersionEditor: { findMany: tracked(() => []) },
    sourceOccurrence: { findMany: tracked(() => []) },
    user: { findMany: tracked(() => []) },
    computeTarget: { findMany: tracked(() => []) },
    sessionDetail: {
      findMany: sessionDetailFindMany(overrides),
      // ISS-9853: the baseline lane RUNS on this fixture now (a cohort no
      // longer loses its window for exceeding a cap), so the double answers the
      // coverage counters production reads off the same statement as the `_sum`.
      aggregate: tracked(() => ({
        _sum: {
          estimatedCost: null,
          inputTokens: null,
          outputTokens: null,
          linesAdded: null,
          linesRemoved: null,
        },
        _count: { _all: 0, estimatedCost: 0 },
        _min: { estimatedCost: null },
      })),
      groupBy: tracked(() => []),
    },
    $queryRaw: tracked(() => [{ unkeyableLoc: 0n, keyedLocs: [] }]),
  };

  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  return probe;
}

describe("ISS-9114 cohort scope batching — getDetailForOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("folds LOC/cost and walks the cohort over the FULL session set, in separate lanes", async () => {
    const probe = installDetailDb();

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      DETAIL_SLUG
    );

    // Pin the ARM. `buildOrphanOnlyDetail` batches the same pair one branch
    // over and emits an empty `computeTargetIds`; without this the suite could
    // silently drift onto that path and re-cover what
    // `detail-read-orphan-parallel.test.ts` already owns.
    expect(detail?.computeTargetIds).toEqual(["target-1"]);
    expect(detail?.sessions).toBe(SESSION_COUNT);
    // ISS-9853: the cohort lane covers every id, in chunks — see the pack-arm
    // twin above for why that expectation changed.
    const coverage = cohortWalkCoverage(probe);
    expect(coverage.ids).toHaveLength(SESSION_COUNT);
    expect(coverage.distinctIds).toBe(SESSION_COUNT);
    expect(coverage.chunks).toBe(EXPECTED_COHORT_CHUNKS);

    const foldedIds = new Set(probe.locCostChunks.flat());
    expect(foldedIds.size).toBe(SESSION_COUNT);
    expect(probe.locCostChunks).toHaveLength(
      Math.ceil(SESSION_COUNT / LOC_COST_CHUNK_SIZE)
    );
    for (const id of SESSION_IDS) {
      expect(foldedIds.has(id)).toBe(true);
    }
  });

  it("issues the LOC/cost and cohort reads concurrently, not in turn", async () => {
    const probe = installDetailDb();

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      DETAIL_SLUG
    );

    expect(detail).not.toBeNull();
    expect(probe.peakInFlight).toBeGreaterThanOrEqual(BATCHED_PEAK_IN_FLIGHT);
  });

  it("absorbs a LOC/cost failure but not a cohort failure", async () => {
    installDetailDb({ failLocCost: true });

    const degraded = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      DETAIL_SLUG
    );

    // Fail-open: the detail is still served, LOC/$ is absent rather than a
    // fabricated number, and the cohort half is real (the >cap cohort reports
    // its own truncation, which only a completed cohort read can say).
    expect(degraded?.computeTargetIds).toEqual(["target-1"]);
    expect(degraded?.sessions).toBe(SESSION_COUNT);
    expect(degraded?.locPerDollar ?? null).toBeNull();
    // ISS-9853: no usage lane in this fixture hit its `take`, so the detail
    // path's id set is the whole cohort and nothing is disclosed as sampled.
    expect(degraded?.mergedPrsTruncated).toBe(false);

    installDetailDb({ failCohort: true });

    await expect(
      agentComponentsService.getDetailForOrg(ORGANIZATION_ID, DETAIL_SLUG)
    ).rejects.toThrow("cohort read failed");
  });
});

/** What the cohort lane read, folded for the assertions in the cases above. */
function cohortWalkCoverage(probe: LaneProbe): {
  ids: string[];
  distinctIds: number;
  chunks: number;
} {
  const ids = probe.cohortScans.flat();
  return {
    ids,
    distinctIds: new Set(ids).size,
    chunks: probe.cohortScans.length,
  };
}

/** Chunks a cohort of {@link SESSION_COUNT} ids takes at the walk's chunk size. */
const EXPECTED_COHORT_CHUNKS = Math.ceil(SESSION_COUNT / COHORT_CHUNK_SIZE);
