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
import { ArtifactType } from "@repo/database";
import {
  DOCUMENTS_THRESHOLDS,
  MILESTONE_SCAN_CAP,
  PR_LANDED_THRESHOLDS,
  STREAK_SCAN_DAYS,
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
  rawQueries: RawQuery[]
) {
  return {
    artifact: {
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    comment: { count: vi.fn().mockResolvedValue(0) },
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

describe("userProfileService.getUserProfileHeadline range scoping (FEA-4064)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeInspectableDb() {
    const artifactCount = vi.fn().mockResolvedValue(0);
    const artifactGroupBy = vi.fn().mockResolvedValue([]);
    const commentCount = vi.fn().mockResolvedValue(0);
    const rawQueries: RawQuery[] = [];
    const db = {
      artifact: { count: artifactCount, groupBy: artifactGroupBy },
      comment: { count: commentCount },
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
      rawQueries,
    };
  }

  /**
   * The PRs-Landed read is the one raw query on the projected-PR-identity
   * basis (its CASE carries the `repo:` prefix); the heatmap read never
   * mentions it.
   */
  function prLandedQueryOf(rawQueries: RawQuery[]) {
    // The identity CASE arrives as a nested fragment, so flatten before
    // matching.
    return rawQueries.find((query) =>
      flattenSqlText(query).includes("'repo:'")
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
    // Documents count + subtype groupBy, comments.
    expect(fake.artifactCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(gte) })
    );
    expect(fake.artifactGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(gte) })
    );
    expect(fake.commentCount).toHaveBeenCalledWith(
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
  });

  it("keeps the five retired loop fields on the headline as 0 for bundles older than ISS-12435", async () => {
    const fake = makeInspectableDb();
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    const headline = await userProfileService.getUserProfileHeadline(
      "user-1",
      "org-1"
    );

    expect(headline).toMatchObject({
      totalLoops: 0,
      avgConcurrency: 0,
      totalTokensInput: 0,
      totalTokensOutput: 0,
      totalEstimatedCost: 0,
    });
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

    // The heatmap SQL lives in a SEPARATE, unranged read now. A range click
    // that re-fetches the headline must NOT re-issue the trailing-year heatmap
    // SQL; the ONE raw query the headline owns is the distinct-merged-PR count
    // (cr on PR #6112).
    expect(fake.rawQueries).toHaveLength(1);
    const headlineSql = flattenSqlText(fake.rawQueries[0]);
    expect(headlineSql).not.toContain("date_trunc('day'");
    expect(headlineSql).toContain("'repo:'");
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
    // in that window, so the lower bound lives on the PR's merged_at — never
    // on the branch artifact's own createdAt (FEA-4064). The count is the
    // distinct-identity SQL (cr on PR #6112), org-merged membership included.
    const landed = prLandedQueryOf(fake.rawQueries);
    expect(landed).toBeDefined();
    const text = flattenSqlText(landed as RawQuery);
    expect(text).toContain("p.merged_at >=");
    expect(text).not.toContain("a.created_at >=");
    // Me scope: the profile counts PRs from branches the user authored.
    expect(text).toContain("a.created_by_id");
    expect(text).toContain("p.last_verified_at IS NOT NULL");
    const values = flattenSqlValues((landed as RawQuery).values);
    expect(values).toContain(startDate);
    expect(values).toContain("user-1");
    expect(values).toContain("org-1");
  });

  it("leaves PRs Landed unbounded (all merged PRs) when no startDate is given", async () => {
    const fake = makeInspectableDb();
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    await userProfileService.getUserProfileHeadline("user-1", "org-1");

    const landed = prLandedQueryOf(fake.rawQueries);
    expect(landed).toBeDefined();
    const text = flattenSqlText(landed as RawQuery);
    // All-time: merged rows only, no lower bound.
    expect(text).toContain("p.merged_at IS NOT NULL");
    expect(text).not.toContain("p.merged_at >=");
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
// (landed-PR merge times, document create times) and emits
// one milestone per crossed threshold, only for thresholds actually reached.
describe("userProfileService.getUserProfileMilestones (FEA-4108)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMilestonesDb(opts: {
    docCreatedAts?: Date[];
    // The PR-landed crossings are computed in SQL
    // (cr-96292 moved the PR walk into the query; the crossing SEMANTICS —
    // landing order, one landing per branch — are integration-covered in
    // delivery-cross-surface-invariant.integration.test.ts). The mocks return
    // the already-resolved crossing rows the real queries would emit, routed
    // by each query's own SQL marker.
    prLandedThresholdRows?: { threshold: number | bigint; earned_at: Date }[];
  }) {
    const documentRows = (opts.docCreatedAts ?? []).map((createdAt) => ({
      createdAt,
    }));
    const artifactFindMany = vi.fn(() => Promise.resolve(documentRows));
    const rawQueries: RawQuery[] = [];
    const db = {
      artifact: { findMany: artifactFindMany },
      $queryRaw: (query: RawQuery) => {
        rawQueries.push(query);
        return Promise.resolve(opts.prLandedThresholdRows ?? []);
      },
    };
    return { db, artifactFindMany, rawQueries };
  }

  /** The PR-landed crossing SQL (the landings/ordered CTE query). */
  function prLandedQuery(rawQueries: RawQuery[]) {
    return rawQueries.find((query) =>
      query.strings.join("?").includes("landed_at")
    );
  }

  /** The document artifact.findMany call (DOCUMENT type). */
  function documentCall(artifactFindMany: Mock) {
    return artifactFindMany.mock.calls.find(
      (call) => call[0]?.where?.type === ArtifactType.DOCUMENT
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
      docCreatedAts: nDates(2),
      // No threshold crossed, so the SQL crossing query returns no rows.
      prLandedThresholdRows: [],
    });
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    const { milestones } = await userProfileService.getUserProfileMilestones(
      "user-1",
      "org-1"
    );
    expect(milestones).toEqual([]);
  });

  it("maps each SQL-computed PRs-landed crossing to a milestone", async () => {
    const firstThreshold = PR_LANDED_THRESHOLDS[0];
    const crossingAt = new Date("2026-04-01T00:00:00.000Z");
    // The crossing walk itself runs in SQL (one row per crossed threshold);
    // its landing-order/one-landing-per-branch semantics are pinned against
    // real Postgres in delivery-cross-surface-invariant.integration.test.ts.
    const fake = makeMilestonesDb({
      prLandedThresholdRows: [
        { threshold: firstThreshold, earned_at: crossingAt },
      ],
    });
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    const { milestones } = await userProfileService.getUserProfileMilestones(
      "user-1",
      "org-1"
    );

    const prMilestones = milestones.filter(
      (m) => m.kind === MilestoneKind.PrsLanded
    );
    expect(prMilestones).toEqual([
      {
        kind: MilestoneKind.PrsLanded,
        threshold: firstThreshold,
        // A Date (the app's useApiClient revives the ISO wire string).
        earnedAt: crossingAt,
      },
    ]);
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

  it("org- and user-scopes the landed-PR and document reads and bounds them", async () => {
    const fake = makeMilestonesDb({});
    databaseMocks.withDb.mockImplementation((fn) => fn(fake.db));

    await userProfileService.getUserProfileMilestones("user-1", "org-1");

    // The landed-PR crossing runs in SQL (cr-96292): one landing per branch
    // (GROUP BY + MAX over the org-merged membership), ranked by LANDING
    // instant — never branch creation — and joined to the fixed thresholds so
    // the read returns at most one row per threshold, uncapped and exact.
    const landedSql = prLandedQuery(fake.rawQueries);
    expect(landedSql).toBeDefined();
    const landedText = flattenSqlText(landedSql as RawQuery);
    expect(landedText).toContain("MIN(p.merged_at)");
    // One landing per DISTINCT projected identity (cr on PR #6112), never per
    // row or per branch.
    expect(landedText).toContain("'repo:'");
    expect(landedText).toContain("GROUP BY 1");
    expect(landedText).toContain("ROW_NUMBER() OVER (ORDER BY landed_at");
    expect(landedText).toContain("o.n = t.threshold");
    // The org-merged membership fragment is composed in, not restated: the
    // session-link EXISTS and the verified stamp both bind here (as a nested
    // Prisma.sql fragment, hence the recursive text flatten).
    expect(landedText).toContain("p.last_verified_at IS NOT NULL");
    expect(landedText).toContain("al.organization_id");
    // Org- and user-scoped, with the fixed thresholds as the only list param.
    const landedValues = flattenSqlValues((landedSql as RawQuery).values);
    expect(landedValues).toContain("org-1");
    expect(landedValues).toContain("user-1");
    for (const threshold of PR_LANDED_THRESHOLDS) {
      expect(landedValues).toContain(threshold);
    }

    const docArgs = documentCall(fake.artifactFindMany)?.[0];
    expect(docArgs).toBeDefined();
    expect(docArgs.where).toMatchObject({
      createdById: "user-1",
      organizationId: "org-1",
      type: ArtifactType.DOCUMENT,
    });
    expect(docArgs.orderBy).toEqual({ createdAt: "asc" });
    expect(docArgs.take).toBe(MILESTONE_SCAN_CAP);

    expect(fake.rawQueries).toHaveLength(1);
  });
});

/** Recursively concatenate a Prisma.sql template's text, descending into
 * nested fragments bound as values, so composed-in predicates are visible. */
function flattenSqlText(query: RawQuery): string {
  let out = query.strings.join("?");
  for (const value of query.values) {
    if (
      value &&
      typeof value === "object" &&
      Array.isArray((value as { strings?: unknown }).strings)
    ) {
      out += flattenSqlText(value as RawQuery);
    }
  }
  return out;
}

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
