/**
 * ISS-10467 — what a BOUNDED orphan lane publishes for one revision.
 *
 * Its own file because it mocks `loadDetailUsageGroups`, which the sibling suite
 * deliberately does NOT: that one evaluates the real content-scope predicate and
 * would be defeated by a double in its place. This one asks the question that
 * predicate cannot reach — when the lane reports its `take` bound, WHICH of the
 * two session figures the fold hands back reaches the wire.
 *
 * `foldOrphanUsageIntoTotals` returns a whole-population `totalSessions` AND
 * leaves the caller's set holding the bounded SAMPLE, on purpose: the sample fans
 * out into the LOC/cost and cohort reads, whose statement count follows its size.
 * Publishing the sample as `sessions` put it beside a POPULATION invocation total
 * in two adjacent rows of one panel, so an invocations-per-session a reader
 * divides out of the drill-down read high with nothing on the surface saying why.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
  loadDetailUsageGroups: vi.fn(),
  resolveComponentIdentity: vi.fn(),
  resolveDetailIdentityScope: vi.fn(),
  loadSessionLocCost: vi.fn(),
  computeCohortPerformance: vi.fn(),
}));

// PARTIAL: the transitive import graph under `detail-invocation-counts` reaches
// real Prisma enums (`ArtifactType`), so replacing the whole module fails the
// suite at import time rather than at an assertion. The string-specifier form
// rather than the typed `import()` one: the typed overload holds the factory to
// `Partial<typeof module>`, which the narrow `Prisma` stub above is not, and
// widening it would mean restating the whole Prisma namespace here.
vi.mock("@repo/database", async () => ({
  ...(await vi.importActual("@repo/database")),
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));
vi.mock("../service/detail-usage-identity", () => ({
  aggregateDetailUsage: (groups: { agentSessionId: string }[]) => ({
    totalInvocations: 0,
    sessionIdSet: new Set(groups.map((g) => g.agentSessionId)),
  }),
  loadDetailUsageGroups: mocks.loadDetailUsageGroups,
}));
vi.mock("../service/version-usage-identity", () => ({
  resolveComponentIdentity: mocks.resolveComponentIdentity,
}));
vi.mock("../content-hash-identity", () => ({
  resolveDetailIdentityScope: mocks.resolveDetailIdentityScope,
}));
vi.mock("../loc-per-dollar", () => ({
  loadSessionLocCost: mocks.loadSessionLocCost,
  locPerDollarForKind: () => null,
}));
vi.mock("../cohort-performance", () => ({
  computeCohortPerformance: mocks.computeCohortPerformance,
}));

import {
  type CohortDeliveryMetrics,
  EMPTY_COHORT_DELIVERY_METRICS,
} from "@repo/api/src/types/analytics";
import { loadVersionUsageForOrg } from "../service/detail-version-usage";

const ORG = "org-iss-10467-bounded";
const KIND = "skill";
const REV = "a".repeat(64);
const SLUG = `${KIND}::${REV}`;
/**
 * The two sessions the bounded lane could actually see.
 *
 * MEMBERS OF THE POPULATION, not a disjoint pair: a sampled session is by
 * definition one of the population's, and `foldOrphanUsageIntoTotals` unions the
 * sample INTO the population set. A fixture whose sample ids were not already
 * population ids would push `totalSessions` to 902 and quietly turn this into an
 * assertion about the fixture rather than about the fold.
 */
const SAMPLE_SESSIONS = ["pop-0", "pop-1"];
/** What the whole-population aggregate reports instead. */
const POPULATION_SESSIONS = 900;
const POPULATION_INVOCATIONS = 12_400;

function boundedLane() {
  return {
    usageGroups: [],
    orphanUsages: SAMPLE_SESSIONS.map((agentSessionId) => ({
      agentSessionId,
      invocationCount: 1,
      componentVersionHash: REV,
      definitionVersionId: null,
    })),
    // ISS-9852: present only because the lane reported its `take` bound.
    orphanTotals: {
      invocations: POPULATION_INVOCATIONS,
      sessionIds: new Set(
        Array.from({ length: POPULATION_SESSIONS }, (_, i) => `pop-${i}`)
      ),
    },
    orphanTruncated: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb({}));
  mocks.resolveDetailIdentityScope.mockResolvedValue({
    key: KIND,
    keys: [KIND],
    inventoryWhere: {},
  });
  mocks.resolveComponentIdentity.mockResolvedValue({
    liveInventoryWhere: {},
    usageIdentity: { kind: KIND, key: KIND, keys: [KIND], inventoryRows: [] },
    knownContentHashes: new Set([REV]),
    definitionHashByContentHash: new Map<string, string>(),
    // Empty, as it is for a revision whose content column is null: the scope
    // then falls back to the coarse hash alone, which is the shape this lane's
    // bounding assertions are indifferent to.
    usageScopeHashByContentHash: new Map<string, string>(),
  });
  mocks.loadDetailUsageGroups.mockResolvedValue(boundedLane());
  mocks.loadSessionLocCost.mockResolvedValue(new Map());
  mocks.computeCohortPerformance.mockResolvedValue(
    EMPTY_COHORT_DELIVERY_METRICS satisfies CohortDeliveryMetrics
  );
});

describe("version-usage over a BOUNDED orphan lane (ISS-10467)", () => {
  it("publishes the POPULATION session count, not the bounded sample's", async () => {
    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV]);

    const entry = result?.entries[0];
    // Both published figures describe the SAME population. The sample size is
    // 2 and would be a plausible-looking answer, which is exactly why it has to
    // be named here rather than left to "not the population".
    expect(entry?.invocations).toBe(POPULATION_INVOCATIONS);
    expect(entry?.sessions).toBe(POPULATION_SESSIONS);
    expect(entry?.sessions).not.toBe(SAMPLE_SESSIONS.length);
  });

  it("still fans the LOC/cost and cohort reads out over the SAMPLE only", async () => {
    await loadVersionUsageForOrg(ORG, SLUG, [REV]);

    // The population set must NOT reach those reads: their statement count
    // follows the id list's size, so handing them 900 ids is the fan-out
    // `foldOrphanUsageIntoTotals` leaves the sample in place to avoid. This is
    // the other half of the fix — moving `sessions` onto the population must not
    // drag the id list along with it.
    expect(mocks.loadSessionLocCost).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      SAMPLE_SESSIONS
    );
    const cohortIds = mocks.computeCohortPerformance.mock.calls[0]?.[2];
    expect(cohortIds).toEqual(SAMPLE_SESSIONS);
  });

  it("does NOT mark the counts as floors when the population aggregate answered", async () => {
    // The lane WAS bounded, so `orphanTruncated` is true — and the counts above
    // are nonetheless exact, because `orphanTotals` stood in for the rows the
    // lane could not see. Marking them here would have the panel print "12,400+"
    // under a family card rendering the same population as a bare "12,400".
    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV]);

    expect(result?.entries[0]?.truncated).toBe(false);
  });

  it("DOES mark them as floors when the aggregate could not stand in", async () => {
    // Same bounded lane, no whole-population aggregate: now the published counts
    // really are the sample's, and the surface must say so. This is the case the
    // flag exists for, and pinning both halves is what stops the fix above from
    // being read as "never disclose a floor".
    mocks.loadDetailUsageGroups.mockResolvedValue({
      ...boundedLane(),
      orphanTotals: null,
    });

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV]);

    const entry = result?.entries[0];
    expect(entry?.truncated).toBe(true);
    // And the counts ARE the sample's here, which is what makes the floor honest.
    expect(entry?.sessions).toBe(SAMPLE_SESSIONS.length);
  });
});
