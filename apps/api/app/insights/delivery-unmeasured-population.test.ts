/**
 * ISS-8424: the Delivery read, driven end to end against the two populations
 * that used to be indistinguishable.
 *
 * Every case here comes in a PAIR, and the pairing is the point: an assertion
 * that only pinned the unmeasured side would also pass against a producer that
 * reported unavailable unconditionally, and one that only pinned the measured
 * side would pass against the fabricated `0` this fixes. The fixtures differ in
 * exactly one input — the census's verified flag — so the emitted difference
 * can only be attributed to it.
 */
import { GitHubPRState as ApiGitHubPRState } from "@repo/api/src/types/github";
import {
  InsightsPeriod,
  InsightsScope,
  InsightsTileAvailabilityState,
} from "@repo/api/src/types/insights";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
  (await import("@/__tests__/support/insights/service.test-db")).databaseMock()
);
vi.mock("@/lib/unmeasured-delivery-population-feature", () => ({
  isUnmeasuredDeliveryPopulationEnabled: vi.fn(),
}));
vi.mock("./unmeasured-delivery-resync", () => ({
  scheduleUnmeasuredDeliveryResync: vi.fn(),
}));
vi.mock("./delivery-pull-request-facts", () => ({
  readDeliveryPullRequestFacts: vi.fn(),
}));

import { withDb } from "@repo/database";
import {
  identityRow,
  makeFakeDb,
  ORG,
} from "@/__tests__/support/insights/service.test-db";
import { isUnmeasuredDeliveryPopulationEnabled } from "@/lib/unmeasured-delivery-population-feature";
import {
  DELIVERY_KPI_DERIVED_FROM_MERGED_PRS,
  type MergedPrVerificationCensus,
} from "./delivery-measurement";
import { readDeliveryPullRequestFacts } from "./delivery-pull-request-facts";
import { insightsService } from "./service";
import { scheduleUnmeasuredDeliveryResync } from "./unmeasured-delivery-resync";

const USER = "user-1";
const ORG_CTX = { organizationId: ORG, userId: USER, scope: InsightsScope.Org };
const NOW = new Date("2026-06-09T12:00:00.000Z");
const MERGED_AT = new Date("2026-06-08T00:00:00.000Z");
const HOUR = 3_600_000;

/**
 * Two merged PRs the window would count, so an unmeasured render cannot be
 * confused with an empty one: the rows are there, only the verification is not.
 */
function mergedPrRows() {
  return [
    {
      mergedAt: MERGED_AT,
      prState: ApiGitHubPRState.Merged,
      id: "pr-1",
      number: 1,
      githubId: "gh-1",
      additions: 900,
      deletions: 100,
      repositoryId: "r1",
      repositoryFullName: "acme/closedloop-ai",
      branchArtifactId: "b1",
      repository: { name: "closedloop-ai" },
      branchArtifact: { createdAt: new Date(MERGED_AT.getTime() - 2 * HOUR) },
    },
    {
      mergedAt: MERGED_AT,
      prState: ApiGitHubPRState.Merged,
      id: "pr-2",
      number: 2,
      githubId: "gh-2",
      additions: 400,
      deletions: 100,
      repositoryId: "r2",
      repositoryFullName: "acme/web",
      branchArtifactId: "b2",
      repository: { name: "web" },
      branchArtifact: { createdAt: new Date(MERGED_AT.getTime() - 3 * HOUR) },
    },
  ];
}

/** Session-linked merged PRs exist; verification has never reached them. */
const UNVERIFIED = {
  hasSessionLinkedMergedPrs: true,
  hasVerifiedMergedPrs: false,
};
/** The same population, after the tier-2 sync stamped some of it. */
const VERIFIED = {
  hasSessionLinkedMergedPrs: true,
  hasVerifiedMergedPrs: true,
};
/** No session-linked merged PRs at all — a real zero, per PRD-683. */
const NO_LINKED_MERGED_PRS = {
  hasSessionLinkedMergedPrs: false,
  hasVerifiedMergedPrs: false,
};

function fakeDbFor(census: MergedPrVerificationCensus) {
  return makeFakeDb({
    mergedPrs: mergedPrRows(),
    mergedPrVerificationCensus: census,
    costSum: 412.5,
    closedPrs: [identityRow("closed-1", 11)],
    priorMergedPrs: [identityRow("prior-1", 12)],
    counts: () => 2,
  });
}

async function getDeliveryWith(
  census: MergedPrVerificationCensus
): ReturnType<typeof insightsService.getDelivery> {
  const { db } = fakeDbFor(census);
  vi.mocked(withDb).mockImplementation((cb) =>
    Promise.resolve(cb(db as never))
  );
  return await insightsService.getDelivery(
    ORG_CTX,
    InsightsPeriod.Quarter,
    NOW
  );
}

function kpiValue(
  result: Awaited<ReturnType<typeof insightsService.getDelivery>>,
  key: string
): number | null | undefined {
  return result.kpis.find((stat) => stat.key === key)?.value;
}

/**
 * `tileAvailability` is optional on the response, so read it through one guard
 * rather than a non-null assertion at each call site — an absent map would
 * otherwise pass every `toBe(Unavailable)` check as `undefined !== available`.
 */
function tileState(
  result: Awaited<ReturnType<typeof insightsService.getDelivery>>,
  tileId: string
): InsightsTileAvailabilityState | undefined {
  // A throw, not an `expect` (Biome's noMisplacedAssertion bans assertions
  // outside a case). It fails the calling case just as loudly, and it is what
  // stops an absent map from passing every `toBe(Unavailable)` check as
  // `undefined !== "available"`.
  if (!result.tileAvailability) {
    throw new Error("the Delivery response carried no tileAvailability map");
  }
  return result.tileAvailability[tileId];
}

beforeEach(() => {
  vi.mocked(withDb).mockReset();
  vi.mocked(isUnmeasuredDeliveryPopulationEnabled).mockResolvedValue(true);
  vi.mocked(readDeliveryPullRequestFacts).mockResolvedValue({
    merged: 2,
    closedUnmerged: 0,
    medianSize: 750,
    sized: 2,
    priorMerged: 0,
  });
  vi.mocked(scheduleUnmeasuredDeliveryResync).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Delivery KPI values under an unverified population (ISS-8424)", () => {
  it("reports the merged-PR KPIs as null when nothing has been verified", async () => {
    const result = await getDeliveryWith(UNVERIFIED);

    // Each of these is `0` on the pre-ISS-8424 producer. `toBeNull` is what
    // separates the two; `toBeFalsy` would pass against both.
    expect(kpiValue(result, "merged")).toBeNull();
    expect(kpiValue(result, "mergedCount")).toBeNull();
    expect(kpiValue(result, "kloc")).toBeNull();
    expect(kpiValue(result, "pr-size")).toBeNull();
    expect(kpiValue(result, "ttm")).toBeNull();
  });

  it("reports the SAME KPIs as real numbers once anything is verified", async () => {
    const result = await getDeliveryWith(VERIFIED);

    // The counterfactual half. Only the census differs from the case above, so
    // a producer that blanked these unconditionally fails here.
    expect(kpiValue(result, "merged")).toBe(2);
    expect(kpiValue(result, "kloc")).toBe(1.5);
    expect(kpiValue(result, "pr-size")).toBe(750);
    expect(kpiValue(result, "ttm")).not.toBeNull();
  });

  it("keeps session cost measured, because no PR row feeds it", async () => {
    const result = await getDeliveryWith(UNVERIFIED);

    expect(kpiValue(result, "cost")).toBe(412.5);
  });

  it("renders a genuine zero as 0, not as unmeasured", async () => {
    // No session-linked merged PRs at all. PRD-683 makes that a real
    // measurement, so the number must survive — this is the case that stops the
    // fix from blanking every quiet org.
    vi.mocked(readDeliveryPullRequestFacts).mockResolvedValue({
      merged: 0,
      sized: 0,
      closedUnmerged: 0,
      medianSize: null,
      priorMerged: 0,
    });
    const { db } = makeFakeDb({
      mergedPrs: [],
      mergedPrVerificationCensus: NO_LINKED_MERGED_PRS,
      counts: () => 0,
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(kpiValue(result, "merged")).toBe(0);
    expect(tileState(result, "kpi:merged")).toBe(
      InsightsTileAvailabilityState.Available
    );
  });

  it("keeps the fabricated zero while the flag is off", async () => {
    vi.mocked(isUnmeasuredDeliveryPopulationEnabled).mockResolvedValue(false);

    const result = await getDeliveryWith(UNVERIFIED);

    // Proves the gate is real rather than decorative: with it off the reader
    // sees exactly what they saw before this change.
    expect(kpiValue(result, "merged")).toBe(2);
    expect(tileState(result, "kpi:merged")).toBe(
      InsightsTileAvailabilityState.Available
    );
  });

  it("classifies every KPI key the Delivery response emits", async () => {
    const result = await getDeliveryWith(VERIFIED);

    // The side-inventory guard: a merged-PR KPI added to the response without a
    // classification would keep printing a fabricated 0 forever, and nothing in
    // the type system catches it because the keys are string literals.
    const unclassified = result.kpis
      .map((stat) => stat.key)
      .filter((key) => DELIVERY_KPI_DERIVED_FROM_MERGED_PRS[key] === undefined);
    expect(unclassified).toEqual([]);
  });
});

describe("Delivery tile availability under an unverified population (ISS-8424)", () => {
  /**
   * Every id the producer gates, spelled out rather than sub-sampled (cr,
   * review-soul). A hand-copied subset can only confirm what its author already
   * remembered: with nine of the twelve named, deleting a chart VARIANT from
   * `MERGED_PR_DERIVED_TILE_IDS` regressed it to "No data yet" and this suite
   * stayed green — which is how the seven catalog variants that were missing
   * went unnoticed in the first place. The catalog side of the inventory is
   * asserted in `packages/app/insights/lib/__tests__/tile-catalog.test.ts`.
   */
  const mergedPrTileIds = [
    "kpi:merged",
    "kpi:kloc",
    "kpi:pr-size",
    "kpi:ttm",
    "kpi:merge-rate",
    "chart:prTrend",
    "chart:prTrend:bar",
    "chart:prTrend:heatmap",
    "chart:klocTrend",
    "chart:klocTrend:bar",
    "chart:klocTrend:heatmap",
    "chart:prByRepo",
    "chart:prByRepo:donut",
    "chart:prByState",
    "chart:prByState:donut",
    "chart:meanTimeToMerge",
    "chart:meanTimeToMerge:donut",
    "chart:branchLifespan",
    "chart:branchLifespan:donut",
  ];

  it("marks every merged-PR tile unavailable when nothing is verified", async () => {
    const result = await getDeliveryWith(UNVERIFIED);

    for (const tileId of mergedPrTileIds) {
      expect(tileState(result, tileId)).toBe(
        InsightsTileAvailabilityState.Unavailable
      );
    }
  });

  it("marks the same tiles available once anything is verified", async () => {
    const result = await getDeliveryWith(VERIFIED);

    expect(tileState(result, "kpi:merged")).toBe(
      InsightsTileAvailabilityState.Available
    );
    expect(tileState(result, "kpi:kloc")).toBe(
      InsightsTileAvailabilityState.Available
    );
    // Not in the map at all before ISS-8424, and they must stay out of it on a
    // measured population rather than becoming permanently-listed tiles.
    expect(tileState(result, "chart:prTrend")).toBeUndefined();
    expect(tileState(result, "chart:branchLifespan:donut")).toBeUndefined();
  });

  /**
   * ISS-12638 (whitlockk): the repo chart became a GitHub-truth tile on the client,
   * and the Cloud+Me fast path reads `undefined` as Unavailable — so without
   * proof here a populated chart is called unavailable on the web dashboard.
   * `kpi:merged`, already proven for the same reason, is the positive control.
   */
  it("proves the repo chart on a measured population, as the GitHub-truth KPIs are", async () => {
    const result = await getDeliveryWith(VERIFIED);

    expect(tileState(result, "chart:prByRepo")).toBe(
      InsightsTileAvailabilityState.Available
    );
    expect(tileState(result, "chart:prByRepo:donut")).toBe(
      InsightsTileAvailabilityState.Available
    );
    expect(tileState(result, "kpi:merged")).toBe(
      InsightsTileAvailabilityState.Available
    );
  });

  it("leaves the branch-population charts measured — they read no PR row", async () => {
    const result = await getDeliveryWith(UNVERIFIED);

    expect(tileState(result, "chart:branchesWithoutPr")).toBe(
      InsightsTileAvailabilityState.Available
    );
  });
});

describe("the unmeasured-population resync trigger (ISS-8424)", () => {
  it("fires for an org whose population has never been verified", async () => {
    await getDeliveryWith(UNVERIFIED);

    expect(scheduleUnmeasuredDeliveryResync).toHaveBeenCalledWith(ORG);
  });

  it("does not fire once anything is verified", async () => {
    await getDeliveryWith(VERIFIED);

    expect(scheduleUnmeasuredDeliveryResync).not.toHaveBeenCalled();
  });

  it("fires regardless of the render flag, so verification lands either way", async () => {
    vi.mocked(isUnmeasuredDeliveryPopulationEnabled).mockResolvedValue(false);

    await getDeliveryWith(UNVERIFIED);

    expect(scheduleUnmeasuredDeliveryResync).toHaveBeenCalledWith(ORG);
  });
});
