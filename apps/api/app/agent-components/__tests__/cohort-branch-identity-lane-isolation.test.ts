/**
 * ISS-9155: the cohort lane's branch identities must be its OWN read.
 *
 * `loadSessionLocCost` is FAIL-OPEN (a failed chunk returns an empty map, so
 * LOC/$ reads "unavailable"); `computeCohortPerformance` is not. So if the two
 * lanes ever SHARE one branch-identity read, the loc lane's failed-empty map
 * becomes the cohort lane's *successful* preload — an empty `Map` is not
 * nullish, so a `preloaded ?? await load(…)` seam accepts it — every fallback
 * row loses its branch key, and the per-branch dedup counts one branch total
 * once PER SESSION. No throw, no log, just a silently bigger number.
 *
 * Nothing shares that read today. This suite pins that through the real
 * `getPackAnalytics` entry point, on the emitted KLOC-per-1k-tokens figure
 * rather than on how the lanes were called. The last case is the control: it
 * shows the exact inflated number a branch-keyless cohort produces, so the
 * first two cannot pass for some unrelated reason.
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { LOC_SOURCE_BRANCH_FALLBACK } from "@repo/api/src/utils/session-loc";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ values }),
  },
}));

vi.mock("@repo/database", () => ({
  Prisma: mocks.Prisma,
  withDb: mocks.withDb,
}));

import { packAnalyticsService } from "../pack-analytics-service";

const ORGANIZATION_ID = "org-1";
const PACK_ID = "pack-1";
const COMPONENT_KIND = AgentComponentKind.Command;
const COMPONENT_KEY = "git-status";
const BRANCH_ARTIFACT_ID = "branch-artifact-1";
const BRANCH_NAME = "feat/shared-branch";
const REPOSITORY_FULL_NAME = "acme/app";
const SESSION_IDS = ["session-a", "session-b"] as const;
const SESSION_STARTED_AT = new Date("2026-02-01T00:00:00.000Z");
/**
 * Both sessions carry the SAME total, which is what `branch_fallback` means:
 * the branch's whole total attributed to each of its authoring sessions.
 */
const LINES_ADDED = 2000;
const LINES_REMOVED = 2000;
const SESSION_INPUT_TOKENS = 40_000;

/**
 * KLOC per 1k tokens with the branch total counted ONCE: 4,000 lines over
 * 80,000 tokens. Written out, not derived, so a dedup change must edit it.
 */
const DEDUPED_EFFICIENCY = 0.05;
/**
 * The same cohort with branch-KEYLESS rows: 8,000 lines over the same tokens.
 * The overstatement — and indistinguishable from a real gain at the surface.
 */
const BRANCH_KEYLESS_EFFICIENCY = 0.1;
/**
 * The sparkline's leading buckets. Every session shares one `sessionStartedAt`,
 * so the trend's zero-width window collapses them all into the last bucket.
 */
const EMPTY_LEADING_BUCKETS = [0, 0, 0, 0, 0, 0, 0];

type LaneProbe = {
  locCostChunkReads: number;
  cohortScanReads: number;
};

/** A session whose LOC came from the branch/PR-total fallback. */
function fallbackSessionRow(artifactId: string) {
  return {
    artifactId,
    linesAdded: LINES_ADDED,
    linesRemoved: LINES_REMOVED,
    locSource: LOC_SOURCE_BRANCH_FALLBACK,
    repositoryFullName: REPOSITORY_FULL_NAME,
    estimatedCost: 1,
    inputTokens: SESSION_INPUT_TOKENS,
    outputTokens: 0,
    sessionStartedAt: SESSION_STARTED_AT,
    artifact: { sourceLinks: [] },
  };
}

/** The session → branch link the dedup is keyed on. */
function sessionBranchLink(sessionId: string) {
  return {
    sourceId: sessionId,
    targetId: BRANCH_ARTIFACT_ID,
    branchParticipation: BranchParticipationKind.Wrote,
    lastContributedAt: SESSION_STARTED_AT,
    createdAt: SESSION_STARTED_AT,
    metadata: null,
    target: {
      name: BRANCH_NAME,
      branch: {
        branchName: BRANCH_NAME,
        repositoryFullName: REPOSITORY_FULL_NAME,
      },
    },
  };
}

/**
 * A `sessionDetail.findMany` that answers each lane separately, so one lane can
 * fail while the other reads normally. The three reads are told apart by the
 * query they issue, not by call order. ISS-9853 retired the `take` that used to
 * separate them — the cohort read walks its id list in chunks and carries no
 * row bound either — so the discriminator is now the ORDER each lane asks for:
 * the cohort walk orders by the primary key it chunks on, the baseline SAMPLE
 * orders by recency (and is the only capped read left), and the LOC/cost chunk
 * read asks for no order at all.
 */
function sessionDetailFindMany(failLocCostLane: boolean, probe: LaneProbe) {
  return vi.fn((args?: { take?: number; orderBy?: unknown }) => {
    if (args?.take !== undefined) {
      // The baseline comparator sample; this suite seeds no baseline rows.
      return Promise.resolve([]);
    }
    if (args?.orderBy) {
      probe.cohortScanReads += 1;
      return Promise.resolve(SESSION_IDS.map(fallbackSessionRow));
    }
    probe.locCostChunkReads += 1;
    if (failLocCostLane) {
      return Promise.reject(new Error("loc/cost chunk read failed"));
    }
    return Promise.resolve(SESSION_IDS.map(fallbackSessionRow));
  });
}

/**
 * Install the pack-analytics `db`. Only the delegates this path reaches are
 * stubbed, so a future read that needs another one fails loudly here.
 * `branchLinks` backs BOTH lanes' identity reads through one delegate, so the
 * fixture cannot favour a lane — a difference between the cases below can only
 * come from which lane actually did the read.
 */
function installDb(options: {
  failLocCostLane: boolean;
  branchLinks: readonly ReturnType<typeof sessionBranchLink>[];
}): LaneProbe {
  const probe: LaneProbe = { cohortScanReads: 0, locCostChunkReads: 0 };
  const db = {
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue(
        SESSION_IDS.map((agentSessionId) => ({
          agentSessionId,
          componentKind: COMPONENT_KIND,
          componentKey: COMPONENT_KEY,
          invocationCount: 1,
          errorCount: 0,
          lastInvokedAt: null,
        }))
      ),
    },
    agentComponent: {
      findMany: vi.fn((args?: { where?: { componentKind?: unknown } }) =>
        Promise.resolve(
          args?.where?.componentKind
            ? [
                {
                  componentKind: COMPONENT_KIND,
                  componentKey: COMPONENT_KEY,
                  packId: PACK_ID,
                },
              ]
            : []
        )
      ),
    },
    artifactLink: {
      findMany: vi.fn().mockResolvedValue([...options.branchLinks]),
    },
    sessionDetail: {
      findMany: sessionDetailFindMany(options.failLocCostLane, probe),
      aggregate: vi.fn().mockResolvedValue({
        _sum: {
          estimatedCost: null,
          inputTokens: null,
          outputTokens: null,
          linesAdded: null,
          linesRemoved: null,
        },
        // ISS-9751's baseline LOC/$ coverage verdict, read off the SAME
        // statement as the `_sum` it certifies (#6878) — an empty window, so
        // there is nothing unpriced and nothing negative.
        _count: { _all: 0, estimatedCost: 0 },
        _min: { estimatedCost: null },
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  return probe;
}

describe("cohort branch identities survive a fail-open LOC/cost lane (ISS-9155)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the cohort's per-branch dedup when the LOC/cost lane fails open", async () => {
    const probe = installDb({
      branchLinks: SESSION_IDS.map(sessionBranchLink),
      failLocCostLane: true,
    });

    const result = await packAnalyticsService.getPackAnalytics(
      ORGANIZATION_ID,
      PACK_ID
    );

    // Fail-open, proven: the lane issued the read that rejects, and a response
    // came back anyway. Both are preconditions — loose on purpose, so the
    // figure below is what fails when the invariant breaks.
    expect(probe.locCostChunkReads).toBeGreaterThan(0);
    expect(probe.cohortScanReads).toBeGreaterThan(0);
    expect(result).not.toBeNull();
    expect(result?.efficiencyTrend).toEqual([
      ...EMPTY_LEADING_BUCKETS,
      DEDUPED_EFFICIENCY,
    ]);
  });

  it("reports that same deduped figure when the LOC/cost lane succeeds", async () => {
    const probe = installDb({
      branchLinks: SESSION_IDS.map(sessionBranchLink),
      failLocCostLane: false,
    });

    const result = await packAnalyticsService.getPackAnalytics(
      ORGANIZATION_ID,
      PACK_ID
    );

    expect(probe.locCostChunkReads).toBeGreaterThan(0);
    expect(probe.cohortScanReads).toBeGreaterThan(0);
    expect(result?.efficiencyTrend).toEqual([
      ...EMPTY_LEADING_BUCKETS,
      DEDUPED_EFFICIENCY,
    ]);
  });

  it("doubles the figure when the cohort's own identity read finds no branch", async () => {
    // The control. With no link to key them, the two fallback rows are not
    // provably the same branch, so the dedup helper sums them per session — the
    // overstatement ISS-9155 exists to keep unreachable through a failed lane.
    const probe = installDb({ branchLinks: [], failLocCostLane: false });

    const result = await packAnalyticsService.getPackAnalytics(
      ORGANIZATION_ID,
      PACK_ID
    );

    expect(probe.cohortScanReads).toBeGreaterThan(0);
    expect(result?.efficiencyTrend).toEqual([
      ...EMPTY_LEADING_BUCKETS,
      BRANCH_KEYLESS_EFFICIENCY,
    ]);
  });
});
