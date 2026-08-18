import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { createDatabaseMockModule } from "../../__tests__/fixtures/mock-modules";

const databaseMocks = vi.hoisted(() => {
  const withDb = vi.fn() as Mock;
  return { withDb };
});

vi.mock("@repo/database", () =>
  createDatabaseMockModule({ withDb: databaseMocks.withDb })
);

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
  },
}));

// Imported after the vi.mock calls so the mocked `@repo/database` factory is the
// module this value resolves against (a top-level value import of a factory-
// mocked module trips Vitest 4's hoist guard).
import { MilestoneKind } from "@repo/api/src/types/user";
import { ArtifactType, GitHubPRState } from "@repo/database";
import {
  DOCUMENTS_THRESHOLDS,
  LOOP_CONCURRENCY_SCAN_CAP,
  MILESTONE_SCAN_CAP,
  PR_LANDED_THRESHOLDS,
  STREAK_SCAN_DAYS,
  TOKEN_THRESHOLDS,
  userProfileService,
} from "./user-profile-service";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Format a Date as a UTC `YYYY-MM-DD` day key (matches the service). */
function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** N days before today as a UTC day key. */
function dayKeyDaysAgo(n: number): string {
  return toDayKey(new Date(Date.now() - n * DAY_MS));
}

/** Shape produced by the mocked `Prisma.sql` tagged template above. */
type RawQuery = { strings: string[]; values: unknown[] };

/**
 * Fake Prisma client for getUserStats. Every aggregate the method fans out to
 * resolves to an empty/zero fixture except the contribution heatmap, which
 * returns the supplied pre-bucketed `{ day, n }` rows and records the raw SQL.
 *
 * Note there is deliberately no `artifact.findMany` here: if the heatmap ever
 * regressed to fetching one row per artifact, these tests would fail loudly.
 */
function makeFakeDb(
  contributionRows: { day: string; n: number }[],
  rawQueries: RawQuery[],
  loopFindMany: Mock = vi.fn().mockResolvedValue([])
) {
  return {
    artifact: {
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    comment: { count: vi.fn().mockResolvedValue(0) },
    loop: {
      count: vi.fn().mockResolvedValue(0),
      findMany: loopFindMany,
      aggregate: vi.fn().mockResolvedValue({
        _sum: { tokensInput: null, tokensOutput: null, estimatedCost: null },
      }),
    },
    $queryRaw: (query: RawQuery) => {
      rawQueries.push(query);
      return Promise.resolve(contributionRows);
    },
  };
}

function getHeatmap(
  contributionRows: { day: string; n: number }[],
  rawQueries: RawQuery[] = []
) {
  databaseMocks.withDb.mockImplementation((fn) =>
    fn(makeFakeDb(contributionRows, rawQueries))
  );
  return userProfileService.getUserContributionHeatmap("user-1", "org-1");
}

describe("userProfileService.getUserContributionHeatmap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("buckets contributions per-day in the database rather than in JS", async () => {
    const rawQueries: RawQuery[] = [];
    await getHeatmap([], rawQueries);

    expect(rawQueries).toHaveLength(1);
    const sql = rawQueries[0].strings.join("?");
    // The aggregation must happen in SQL so at most ~365 rows cross the wire.
    expect(sql).toContain("date_trunc('day', created_at)");
    expect(sql).toContain("COUNT(*)::int");
    expect(sql).toContain("GROUP BY day");
    // Org-scoped and user-scoped, with the DOCUMENT type filter preserved.
    expect(rawQueries[0].values).toEqual([
      "user-1",
      "org-1",
      "DOCUMENT",
      expect.any(Date),
    ]);
  });

  it("maps DB day counts onto a dense 364-day heatmap, zero-filling gaps", async () => {
    // Learn the enumerated day keys from an empty run, so the assertion does
    // not have to re-derive today's UTC key itself.
    const baseline = await getHeatmap([]);
    expect(baseline.contributionHeatmap).toHaveLength(364);
    expect(baseline.contributionHeatmap.every((d) => d.count === 0)).toBe(true);

    // Falls back to "" rather than casting; the length assertion above already
    // guarantees both endpoints exist, so a "" key would fail the test loudly.
    const lastDay = baseline.contributionHeatmap.at(-1)?.date ?? "";
    const firstDay = baseline.contributionHeatmap[0].date;

    const stats = await getHeatmap([
      { day: lastDay, n: 7 },
      { day: firstDay, n: 3 },
      // A day outside the enumerated window is ignored rather than appended.
      { day: "1999-01-01", n: 99 },
    ]);

    expect(stats.contributionHeatmap).toHaveLength(364);
    expect(stats.contributionHeatmap.at(-1)).toEqual({
      date: lastDay,
      count: 7,
    });
    expect(stats.contributionHeatmap[0]).toEqual({ date: firstDay, count: 3 });
    // Everything between the two seeded endpoints stays zero-filled.
    expect(
      stats.contributionHeatmap.slice(1, -1).every((d) => d.count === 0)
    ).toBe(true);
  });
});

describe("userProfileService.getUserProfileHeadline loop concurrency read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bounds the concurrency read to the trailing year and a take cap", async () => {
    const loopFindMany = vi.fn().mockResolvedValue([]);
    databaseMocks.withDb.mockImplementation((fn) =>
      fn(makeFakeDb([], [], loopFindMany))
    );

    await userProfileService.getUserProfileHeadline("user-1", "org-1");

    // The concurrency read feeds an O(n²) interval-overlap scan, so loading a
    // heavy user's entire loop history is a memory + CPU risk. It must be
    // recency-windowed and row-capped like the contribution heatmap read.
    expect(loopFindMany).toHaveBeenCalledTimes(1);
    const args = loopFindMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      userId: "user-1",
      organizationId: "org-1",
      startedAt: { gte: expect.any(Date) },
    });
    expect(args.take).toBe(LOOP_CONCURRENCY_SCAN_CAP);
    expect(args.orderBy).toEqual({ startedAt: "desc" });
  });
});

describe("userProfileService.getUserProfileHeadline range scoping (FEA-4064)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeInspectableDb() {
    const artifactCount = vi.fn().mockResolvedValue(0);
    const artifactGroupBy = vi.fn().mockResolvedValue([]);
    const commentCount = vi.fn().mockResolvedValue(0);
    const loopCount = vi.fn().mockResolvedValue(0);
    const loopFindMany = vi.fn().mockResolvedValue([]);
    const loopAggregate = vi.fn().mockResolvedValue({
      _sum: { tokensInput: null, tokensOutput: null, estimatedCost: null },
    });
    const rawQueries: RawQuery[] = [];
    const db = {
      artifact: { count: artifactCount, groupBy: artifactGroupBy },
      comment: { count: commentCount },
      loop: {
        count: loopCount,
        findMany: loopFindMany,
        aggregate: loopAggregate,
      },
      $queryRaw: (query: RawQuery) => {
        rawQueries.push(query);
        return Promise.resolve([]);
      },
    };
    return {
      db,
      artifactCount,
      artifactGroupBy,
      commentCount,
      loopCount,
      loopFindMany,
      loopAggregate,
      rawQueries,
    };
  }

  /**
   * The PRs-Landed count is the one `artifact.count` call whose where clause
   * targets BRANCH artifacts with a `branch.currentPullRequestDetail` predicate.
   * Isolating it lets the tests assert on the merge-time windowing distinct from
   * the DOCUMENT-count call that shares the same mocked delegate.
   */
  function findPrLandedCall(artifactCount: Mock) {
    return artifactCount.mock.calls.find(
      (call) => call[0]?.where?.branch?.currentPullRequestDetail !== undefined
    );
  }

  it("applies the startDate lower bound to every ranged aggregate", async () => {
    const fake = makeInspectableDb();
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));
    const startDate = new Date("2026-01-01T00:00:00.000Z");

    await userProfileService.getUserProfileHeadline(
      "user-1",
      "org-1",
      startDate
    );

    const gte = { createdAt: { gte: startDate } };
    // Documents count + subtype groupBy, comments, loops count, token aggregate.
    expect(fake.artifactCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(gte) })
    );
    expect(fake.artifactGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(gte) })
    );
    expect(fake.commentCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(gte) })
    );
    expect(fake.loopCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(gte) })
    );
    expect(fake.loopAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(gte) })
    );
  });

  it("leaves the ranged aggregates unbounded when no startDate is given", async () => {
    const fake = makeInspectableDb();
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    await userProfileService.getUserProfileHeadline("user-1", "org-1");

    // Omitted (not null) so the all-time behavior is byte-identical to before.
    expect(fake.artifactCount.mock.calls[0][0].where.createdAt).toBeUndefined();
    expect(fake.commentCount.mock.calls[0][0].where.createdAt).toBeUndefined();
    expect(fake.loopCount.mock.calls[0][0].where.createdAt).toBeUndefined();
    expect(fake.loopAggregate.mock.calls[0][0].where.createdAt).toBeUndefined();
  });

  it("never issues the trailing-year heatmap SQL from the ranged headline read (FEA-4064 split)", async () => {
    const fake = makeInspectableDb();
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));
    const startDate = new Date("2026-06-01T00:00:00.000Z");

    await userProfileService.getUserProfileHeadline(
      "user-1",
      "org-1",
      startDate
    );

    // The heatmap SQL lives in a SEPARATE, unranged read now. A range click that
    // re-fetches the headline must NOT re-issue the trailing-year heatmap SQL,
    // so the headline read fires no $queryRaw at all.
    expect(fake.rawQueries).toHaveLength(0);
  });

  it("windows PRs Landed by the PR's merge time, not the branch createdAt", async () => {
    const fake = makeInspectableDb();
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));
    const startDate = new Date("2026-05-01T00:00:00.000Z");

    await userProfileService.getUserProfileHeadline(
      "user-1",
      "org-1",
      startDate
    );

    // A branch cut months before the window but merged inside it is a landing
    // in that window, so the lower bound lives on currentPullRequestDetail
    // .mergedAt — never on the branch artifact's own createdAt (FEA-4064).
    const prLandedCall = findPrLandedCall(fake.artifactCount);
    expect(prLandedCall).toBeDefined();
    const where = prLandedCall?.[0].where;
    expect(where.createdAt).toBeUndefined();
    expect(where.branch.currentPullRequestDetail).toEqual({
      prState: GitHubPRState.MERGED,
      mergedAt: { gte: startDate },
    });
  });

  it("leaves PRs Landed unbounded (all merged PRs) when no startDate is given", async () => {
    const fake = makeInspectableDb();
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    await userProfileService.getUserProfileHeadline("user-1", "org-1");

    const prLandedCall = findPrLandedCall(fake.artifactCount);
    expect(prLandedCall).toBeDefined();
    // Omitted, not null, so the all-time count stays byte-identical to before.
    expect(
      prLandedCall?.[0].where.branch.currentPullRequestDetail.mergedAt
    ).toBeUndefined();
  });

  it("tightens the concurrency scan lower bound to the selected window", async () => {
    const fake = makeInspectableDb();
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));
    // A 30-day window is well inside the trailing year, so the concurrency scan
    // must adopt this tighter bound rather than staying on oneYearAgo, or the
    // Avg Loop Concurrency headline lies about the window its label claims.
    const startDate = new Date(Date.now() - 30 * DAY_MS);

    await userProfileService.getUserProfileHeadline(
      "user-1",
      "org-1",
      startDate
    );

    expect(fake.loopFindMany).toHaveBeenCalledTimes(1);
    const where = fake.loopFindMany.mock.calls[0][0].where;
    expect(where.startedAt).toEqual({ gte: startDate });
  });

  it("keeps the concurrency scan on the trailing year for a 1y+ window (bounded scan)", async () => {
    const fake = makeInspectableDb();
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));
    // A window OLDER than a year must not widen the O(n²) scan past the trailing
    // year — the year ceiling is what keeps the scan bounded for heavy users.
    const twoYearsAgo = new Date(Date.now() - 2 * 365 * DAY_MS);

    await userProfileService.getUserProfileHeadline(
      "user-1",
      "org-1",
      twoYearsAgo
    );

    const floor = fake.loopFindMany.mock.calls[0][0].where.startedAt
      .gte as Date;
    // Floor is oneYearAgo, strictly newer than the 2-years-ago request.
    expect(floor.getTime()).toBeGreaterThan(twoYearsAgo.getTime());
  });

  it("keeps the concurrency scan on the trailing year when no window is selected", async () => {
    const fake = makeInspectableDb();
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    await userProfileService.getUserProfileHeadline("user-1", "org-1");

    // All-time headline totals still pair with a year-bounded concurrency scan.
    expect(fake.loopFindMany.mock.calls[0][0].where.startedAt).toEqual({
      gte: expect.any(Date),
    });
  });
});

// FEA-4108: consecutive-active-days streak. The service reads DISTINCT active
// day keys (document-artifact creation days, UTC-bucketed) via $queryRaw and
// derives the current/best streak in JS.
describe("userProfileService.getUserProfileStanding (FEA-4108 streak)", () => {
  // Pin "today" so the day keys built by dayKeyDaysAgo cannot drift relative to
  // computeStreak's own `new Date()` across a UTC-midnight boundary mid-run.
  // Fixed at midday UTC so a same-day fixture and the service agree on "today".
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeStandingDb(activeDayKeys: string[]) {
    const rawQueries: RawQuery[] = [];
    const db = {
      $queryRaw: (query: RawQuery) => {
        rawQueries.push(query);
        return Promise.resolve(activeDayKeys.map((day) => ({ day })));
      },
    };
    return { db, rawQueries };
  }

  function getStanding(activeDayKeys: string[]) {
    const fake = makeStandingDb(activeDayKeys);
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));
    return {
      result: userProfileService.getUserProfileStanding("user-1", "org-1"),
      rawQueries: fake.rawQueries,
    };
  }

  it("returns null streak when the user has no active day (no fake zero)", async () => {
    const { result } = getStanding([]);
    expect((await result).streak).toBeNull();
  });

  it("counts the current run ending today", async () => {
    const { result } = getStanding([
      dayKeyDaysAgo(2),
      dayKeyDaysAgo(1),
      dayKeyDaysAgo(0),
    ]);
    const { streak } = await result;
    expect(streak).toEqual({ currentDays: 3, bestDays: 3 });
  });

  it("breaks the current streak on a gap but keeps the historical best", async () => {
    // A run of 4 consecutive days, then a two-day gap, then a run of 2 ending
    // today. The gap breaks the current streak: current = 2, best = 4.
    const { result } = getStanding([
      dayKeyDaysAgo(9),
      dayKeyDaysAgo(8),
      dayKeyDaysAgo(7),
      dayKeyDaysAgo(6),
      // gap at days 5 and 4
      dayKeyDaysAgo(1),
      dayKeyDaysAgo(0),
    ]);
    const { streak } = await result;
    expect(streak).toEqual({ currentDays: 2, bestDays: 4 });
  });

  it("reports currentDays 0 when the latest active day is older than yesterday", async () => {
    // Latest activity was 3 days ago: the streak has already broken, so there
    // is no current run even though there is a historical best of 2.
    const { result } = getStanding([dayKeyDaysAgo(4), dayKeyDaysAgo(3)]);
    const { streak } = await result;
    expect(streak).toEqual({ currentDays: 0, bestDays: 2 });
  });

  it("scopes the active-day scan to the user, org, DOCUMENT type, and window", async () => {
    const { result, rawQueries } = getStanding([dayKeyDaysAgo(0)]);
    await result;

    expect(rawQueries).toHaveLength(1);
    const sql = rawQueries[0].strings.join("?");
    expect(sql).toContain("SELECT DISTINCT");
    expect(sql).toContain("date_trunc('day', created_at)");
    // Org-scoped + user-scoped, DOCUMENT type filter, windowed lower bound.
    expect(rawQueries[0].values).toEqual([
      "user-1",
      "org-1",
      "DOCUMENT",
      expect.any(Date),
    ]);
    const scanStart = rawQueries[0].values[3] as Date;
    // The lower bound is ~STREAK_SCAN_DAYS days ago (bounded read).
    const daysBack = Math.round((Date.now() - scanStart.getTime()) / DAY_MS);
    expect(daysBack).toBe(STREAK_SCAN_DAYS - 1);
  });
});

// FEA-4108: lifetime milestones. The service reads ordered per-user aggregates
// (landed-PR merge times, document create times, per-day token totals) and emits
// one milestone per crossed threshold, only for thresholds actually reached.
describe("userProfileService.getUserProfileMilestones (FEA-4108)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMilestonesDb(opts: {
    prMergedAts?: Date[];
    docCreatedAts?: Date[];
    // The token-threshold crossings are now computed in SQL; the mock returns
    // the already-resolved crossing rows (one per crossed threshold) that the
    // real query would emit.
    tokenThresholdRows?: { threshold: number | bigint; earned_at: Date }[];
  }) {
    // Both the landed-PR read and the document read go through
    // artifact.findMany now (PRs are counted as merged BRANCH artifacts, the
    // same dedupe identity the headline uses). Route by the query's `where`:
    // a BRANCH+currentPullRequestDetail predicate is the PR-landed read; a
    // DOCUMENT predicate is the document read.
    const prLandedRows = (opts.prMergedAts ?? []).map((mergedAt) => ({
      branch: { currentPullRequestDetail: { mergedAt } },
    }));
    const documentRows = (opts.docCreatedAts ?? []).map((createdAt) => ({
      createdAt,
    }));
    const artifactFindMany = vi.fn(
      (args: { where?: Record<string, unknown> }) =>
        Promise.resolve(
          args?.where?.branch === undefined ? documentRows : prLandedRows
        )
    );
    const rawQueries: RawQuery[] = [];
    const db = {
      artifact: { findMany: artifactFindMany },
      $queryRaw: (query: RawQuery) => {
        rawQueries.push(query);
        return Promise.resolve(opts.tokenThresholdRows ?? []);
      },
    };
    return { db, artifactFindMany, rawQueries };
  }

  /** The landed-PR artifact.findMany call (BRANCH + currentPullRequestDetail). */
  function prLandedCall(artifactFindMany: Mock) {
    return artifactFindMany.mock.calls.find(
      (call) => call[0]?.where?.branch !== undefined
    );
  }

  /** The document artifact.findMany call (DOCUMENT type). */
  function documentCall(artifactFindMany: Mock) {
    return artifactFindMany.mock.calls.find(
      (call) => call[0]?.where?.branch === undefined
    );
  }

  /** Build N Dates, oldest-first, one day apart, ending today. */
  function nDates(n: number): Date[] {
    const out: Date[] = [];
    for (let i = n - 1; i >= 0; i--) {
      out.push(new Date(Date.now() - i * DAY_MS));
    }
    return out;
  }

  it("returns no milestones when no threshold is crossed (no fake empty state)", async () => {
    const fake = makeMilestonesDb({
      prMergedAts: nDates(3),
      docCreatedAts: nDates(2),
      // No token threshold crossed, so the SQL crossing query returns no rows.
      tokenThresholdRows: [],
    });
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    const { milestones } = await userProfileService.getUserProfileMilestones(
      "user-1",
      "org-1"
    );
    expect(milestones).toEqual([]);
  });

  it("emits a PRs-landed milestone only for each crossed threshold", async () => {
    const firstThreshold = PR_LANDED_THRESHOLDS[0];
    const secondThreshold = PR_LANDED_THRESHOLDS[1];
    // Enough landed PRs to cross the first threshold but not the second.
    const fake = makeMilestonesDb({ prMergedAts: nDates(secondThreshold - 1) });
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    const { milestones } = await userProfileService.getUserProfileMilestones(
      "user-1",
      "org-1"
    );

    const prMilestones = milestones.filter(
      (m) => m.kind === MilestoneKind.PrsLanded
    );
    expect(prMilestones).toHaveLength(1);
    expect(prMilestones[0].threshold).toBe(firstThreshold);
    // earnedAt is the merge time of the threshold-th (1-based) landed PR, a Date
    // (the app's useApiClient revives the ISO wire string back to a Date).
    expect(prMilestones[0].earnedAt).toBeInstanceOf(Date);
  });

  it("emits document milestones from the ordered create times", async () => {
    const threshold = DOCUMENTS_THRESHOLDS[0];
    const fake = makeMilestonesDb({ docCreatedAts: nDates(threshold) });
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    const { milestones } = await userProfileService.getUserProfileMilestones(
      "user-1",
      "org-1"
    );

    const docMilestones = milestones.filter(
      (m) => m.kind === MilestoneKind.DocumentsCreated
    );
    expect(docMilestones).toHaveLength(1);
    expect(docMilestones[0].threshold).toBe(threshold);
  });

  it("maps each SQL-computed token-threshold crossing to a milestone at the crossing loop's completion time", async () => {
    const firstThreshold = TOKEN_THRESHOLDS[0];
    // The crossing timestamp is the loop's completion instant (not a day
    // bucket): tokens accrue during a run, so completion is when the total was
    // actually reached — this instant would be wrong if it used loop creation.
    const crossingAt = new Date("2026-06-14T23:30:00.000Z");
    const fake = makeMilestonesDb({
      tokenThresholdRows: [
        { threshold: firstThreshold, earned_at: crossingAt },
      ],
    });
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    const { milestones } = await userProfileService.getUserProfileMilestones(
      "user-1",
      "org-1"
    );

    const tokenMilestones = milestones.filter(
      (m) => m.kind === MilestoneKind.TokensUsed
    );
    expect(tokenMilestones).toHaveLength(1);
    expect(tokenMilestones[0].threshold).toBe(firstThreshold);
    expect(tokenMilestones[0].earnedAt).toBeInstanceOf(Date);
    expect(tokenMilestones[0].earnedAt.getTime()).toBe(crossingAt.getTime());
  });

  it("org- and user-scopes the landed-PR and document reads and bounds them", async () => {
    const fake = makeMilestonesDb({});
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    await userProfileService.getUserProfileMilestones("user-1", "org-1");

    // The landed-PR read counts merged BRANCH artifacts (same dedupe identity
    // as the headline), org- and user-scoped, ordered by the current PR's merge
    // time, and bounded by the scan cap.
    const prArgs = prLandedCall(fake.artifactFindMany)?.[0];
    expect(prArgs).toBeDefined();
    expect(prArgs.where).toMatchObject({
      organizationId: "org-1",
      type: ArtifactType.BRANCH,
      createdById: "user-1",
      branch: {
        currentPullRequestDetail: {
          prState: GitHubPRState.MERGED,
          mergedAt: { not: null },
        },
      },
    });
    expect(prArgs.orderBy).toEqual({
      branch: { currentPullRequestDetail: { mergedAt: "asc" } },
    });
    expect(prArgs.take).toBe(MILESTONE_SCAN_CAP);

    const docArgs = documentCall(fake.artifactFindMany)?.[0];
    expect(docArgs).toBeDefined();
    expect(docArgs.where).toMatchObject({
      createdById: "user-1",
      organizationId: "org-1",
      type: ArtifactType.DOCUMENT,
    });
    expect(docArgs.orderBy).toEqual({ createdAt: "asc" });
    expect(docArgs.take).toBe(MILESTONE_SCAN_CAP);

    // The token-crossing read is org- and user-scoped in SQL, buckets the
    // crossing at loop completion (COALESCE(completed_at, created_at)) rather
    // than creation, and returns only the fixed thresholds via a windowed
    // cumulative sum — so it never grows one row per active day.
    expect(fake.rawQueries).toHaveLength(1);
    const tokenSql = fake.rawQueries[0].strings.join("?");
    expect(tokenSql).toContain("COALESCE(completed_at, created_at)");
    expect(tokenSql).toContain("OVER (");
    expect(tokenSql).toContain("running_total >= t.threshold");
    // user_id and organization_id are the first two bound params; the fixed
    // TOKEN_THRESHOLDS follow, embedded as nested Prisma.sql/Prisma.join
    // fragments for the UNNEST(ARRAY[...]) list. Prisma flattens those nested
    // fragments' values into the final parameter list at execution time, so
    // collect every leaf param and assert the exact bound-value set.
    const values = fake.rawQueries[0].values;
    expect(values[0]).toBe("user-1");
    expect(values[1]).toBe("org-1");
    expect(flattenSqlValues(values)).toEqual([
      "user-1",
      "org-1",
      ...TOKEN_THRESHOLDS,
    ]);
  });
});

/** Recursively flatten a Prisma.sql values array (nested fragments carry their
 * own `values`) into the flat, ordered list of leaf bound parameters. */
function flattenSqlValues(values: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const value of values) {
    if (
      value &&
      typeof value === "object" &&
      Array.isArray((value as { values?: unknown }).values)
    ) {
      out.push(...flattenSqlValues((value as { values: unknown[] }).values));
    } else {
      out.push(value);
    }
  }
  return out;
}
