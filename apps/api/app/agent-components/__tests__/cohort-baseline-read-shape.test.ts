/**
 * ISS-9114 finding 1 — the baseline lane's READ SHAPE.
 *
 * The baseline used to issue five reads over one identical
 * `baselineSessionWhere(baseline)` scope strictly in turn: a tokens/cost
 * aggregate, a non-fallback LOC aggregate, two `$queryRaw` CTEs that EACH
 * re-derived `fallback_sessions` from the same window predicate, and the capped
 * sample. Nothing between them is data-dependent.
 *
 * Two properties are asserted, both structural rather than timed: the two raw
 * CTEs are now ONE statement, and the reads that remain overlap. The values
 * those reads produce are covered by `cohort-performance.test.ts` (unit) and
 * `cohort-baseline-loc.integration.test.ts` (real Postgres); this file only
 * polices how many statements the scope costs and whether they run together.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ values }),
  },
}));

vi.mock("@repo/database", () => ({ Prisma: mocks.Prisma }));

import { computeCohortPerformance } from "../cohort-performance";

const ORGANIZATION_ID = "org-baseline-shape";
const COHORT_SESSION_ID = "session-cohort";
const BASELINE_SESSION_ID = "session-baseline";

/**
 * Peak concurrent in-flight queries the baseline lane reaches under this
 * fixture: the four baseline reads issued together — the tokens/cost aggregate (which since #6878 also carries ISS-9751's
 * coverage verdict, in that same statement rather than a second one), the
 * non-fallback LOC aggregate, the merged fallback `$queryRaw`, and the capped
 * sample.
 *
 * The floor is what makes a PARTIAL regression fail: fully serial reads peak at
 * 1, and pulling any single read back out of the batch caps the peak at 3.
 */
const BATCHED_PEAK_IN_FLIGHT = 4;

/** One statement for both fallback halves — it was two before ISS-9114. */
const EXPECTED_FALLBACK_STATEMENTS = 1;

type ProbeState = { peak: number };

function sessionRow(artifactId: string) {
  return {
    artifactId,
    linesAdded: 100,
    linesRemoved: 0,
    locSource: "git",
    repositoryFullName: "acme/web",
    estimatedCost: 1,
    inputTokens: 10n,
    outputTokens: 10n,
    sessionStartedAt: new Date("2026-08-01T00:00:00.000Z"),
    artifact: { sourceLinks: [] },
  };
}

/**
 * A fake client whose every delegate holds its in-flight slot across one
 * microtask, so reads issued in the same tick overlap and reads issued in turn
 * never do — the deterministic shape `detail-read-orphan-parallel.test.ts` uses.
 */
function installDb() {
  const probe: ProbeState = { peak: 0 };
  let inFlight = 0;

  const tracked =
    <T>(resolve: (args: never) => T) =>
    async (args: never): Promise<T> => {
      inFlight += 1;
      probe.peak = Math.max(probe.peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return resolve(args);
    };

  const queryRaw = vi.fn(tracked(() => [{ unkeyableLoc: 0n, keyedLocs: [] }]));

  const db = {
    sessionDetail: {
      findMany: vi.fn(
        tracked((args: { where: { artifactId?: { notIn?: string[] } } }) =>
          args.where.artifactId?.notIn
            ? [sessionRow(BASELINE_SESSION_ID)]
            : [sessionRow(COHORT_SESSION_ID)]
        )
      ),
      aggregate: vi.fn(
        tracked(() => ({
          _sum: {
            linesAdded: 50,
            linesRemoved: 0,
            estimatedCost: 1,
            inputTokens: 5n,
            outputTokens: 5n,
          },
          // ISS-9751's baseline LOC/$ coverage verdict, read off the SAME
          // statement as the `_sum` it certifies (#6878) — one priced row, no
          // negative — rather than the separate `count` that made it a second
          // READ COMMITTED snapshot.
          _count: { _all: 1, estimatedCost: 1 },
          _min: { estimatedCost: 1 },
        }))
      ),
    },
    // ISS-9853: quality is a rowless aggregate now, not a capped evaluation read.
    judgeScore: {
      aggregate: vi.fn(
        tracked(() => ({ _sum: { score: null }, _count: { score: 0 } }))
      ),
    },
    $queryRaw: queryRaw,
  };

  return { db, probe, queryRaw };
}

describe("ISS-9114 baseline lane read shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives the fallback session scope once, in a single statement", async () => {
    const { db, queryRaw } = installDb();

    await computeCohortPerformance(
      db as unknown as Parameters<typeof computeCohortPerformance>[0],
      ORGANIZATION_ID,
      [COHORT_SESSION_ID],
      { cohortSampled: false }
    );

    expect(queryRaw).toHaveBeenCalledTimes(EXPECTED_FALLBACK_STATEMENTS);
  });

  it("issues the independent baseline reads concurrently, not in turn", async () => {
    const { db, probe } = installDb();

    const result = await computeCohortPerformance(
      db as unknown as Parameters<typeof computeCohortPerformance>[0],
      ORGANIZATION_ID,
      [COHORT_SESSION_ID],
      { cohortSampled: false }
    );

    // Behaviour is unchanged: the baseline is still computed and compared.
    expect(result.locDelta).not.toBeNull();
    expect(probe.peak).toBeGreaterThanOrEqual(BATCHED_PEAK_IN_FLIGHT);
  });
});
