import { InsightsScope } from "@repo/api/src/types/insights";
import { Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MeshDb,
  meshDbState,
  resetMeshDb,
} from "@/__tests__/support/session-mesh/session-mesh-db.test-helpers";
import { sessionMeshService } from "../service";
import { readSessionMeshInsights } from "./insights";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (
    await import(
      "@/__tests__/support/session-mesh/session-mesh-db.test-helpers"
    )
  ).meshWithDb(),
}));

const NOW = new Date("2026-09-25T12:00:00.000Z");
const DAY_MS = 86_400_000;
const ORG = "0199a1b2-0000-7000-8000-000000000001";
const USER = "0199a1b2-0000-7000-8000-000000000002";
// The PARAMETERIZED form, not a bare `user_id = `: the delivery-cohort join
// (ISS-11435) contains `event.user_id = cohort.recipient_user_id`, which is a
// join predicate and not a scope filter, so the broader matcher would report
// organization scope as user-filtered.
const USER_FILTER = "user_id = ?::uuid";
const INDIVIDUAL_NOTE_PREFIX = "Individual-user scope";
/**
 * The `relevance` JSON keys `relevanceFor` persists (apps/api/app/session-mesh/
 * service.ts:66). Literals rather than a shared constant, deliberately: these
 * are the shape of PERSISTED ROWS, so a fixture built from our own constant
 * would agree with our own rename.
 */
const RELEVANCE_OVERLAP_KEYS = [
  "pathOverlap",
  "symbolOverlap",
  "sameBranch",
  "samePullRequest",
  "artifactOverlap",
  "blocksArtifacts",
  "blockedByArtifacts",
];
/** A `to_char(` whose first argument is not re-zoned to UTC. */
const UNZONED_TO_CHAR = /to_char\((?!\s*\w+\s+AT TIME ZONE)/;

let db: MeshDb;

function totals(overrides: Record<string, number | null> = {}) {
  return {
    active: 2,
    eligible: 3,
    attempted: 4,
    delivered: 5,
    acknowledged: 6,
    useful: 1,
    notUseful: 2,
    cantTell: 3,
    conflictsResolved: 1,
    recipientActions: 4,
    routed: 5,
    requestResponseLatencyMs: 1500,
    estimatedTimeSavedMinutes: null,
    estimatedCostSavedUsd: null,
    coordinationOverheadMs: null,
    invalidAttributions: 0,
    ...overrides,
  };
}

const trend = [
  { day: "2026-09-24", published: 1, delivered: 2, acknowledged: 0 },
];

/**
 * ISS-11756 added a THIRD read in the same transaction — the org's measured
 * round-trip price — so the double stubs three responses, not two. The
 * expectations below are unchanged; only the harness grew a row.
 */
function costRow(overrides: Record<string, number | null> = {}) {
  return {
    roundTrips: 1000,
    pricedRoundTrips: 1000,
    estimatedCostUsd: 430,
    cacheReadTokens: 200_000_000,
    outputTokens: 700_000,
    ...overrides,
  };
}

function densityRow(overrides: Record<string, unknown> = {}) {
  return {
    day: "2026-09-24",
    queued: 100,
    detected: 25,
    surfaced: 20,
    pathCollisions: 18,
    symbolCollisions: 9,
    branchCollisions: 4,
    pullRequestCollisions: 2,
    artifactCollisions: 1,
    blockingCollisions: 0,
    activeAgents: 5,
    ...overrides,
  };
}

function arrangeRows(
  totalRows: unknown[] = [totals()],
  trendRows = trend,
  costRows: unknown[] = [costRow()],
  densityRows: unknown[] = [densityRow()]
) {
  db.$queryRaw
    .mockResolvedValueOnce(totalRows)
    .mockResolvedValueOnce(trendRows)
    .mockResolvedValueOnce(costRows)
    .mockResolvedValueOnce(densityRows);
}

function queries(): Prisma.Sql[] {
  return db.$queryRaw.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = resetMeshDb();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("readSessionMeshInsights window", () => {
  it("defaults to the last 30 days ending now in a repeatable-read tx", async () => {
    arrangeRows();

    const report = await readSessionMeshInsights(ORG);

    const from = new Date(NOW.getTime() - 30 * DAY_MS);
    expect(report.window).toEqual({
      from: from.toISOString(),
      to: NOW.toISOString(),
    });
    const [totalsQuery, trendQuery] = queries();
    // Live participation is measured at `now`; every event count is bounded
    // by the organization and the [from, to] window.
    expect(totalsQuery?.values.slice(0, 2)).toEqual([ORG, NOW]);
    expect(totalsQuery?.values).toEqual(expect.arrayContaining([from, NOW]));
    expect(trendQuery?.values).toEqual([
      ORG,
      from,
      NOW,
      ORG,
      from,
      NOW,
      ORG,
      from,
      NOW,
    ]);
    // ISS-11812: the round-trip cost read runs OUTSIDE this transaction, as its
    // own plain connection. Inside it, it spent the transaction's 5s budget and
    // 500'd the org-scope card. The `plain` entry below is that fix; its absence
    // would mean the read had drifted back into the transaction.
    expect(meshDbState.calls).toEqual([
      {
        kind: "tx",
        options: {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        },
      },
      { kind: "plain", options: undefined },
      { kind: "plain", options: undefined },
    ]);
  });

  it("anchors the default 30-day span to a supplied end", async () => {
    arrangeRows();
    const to = new Date(NOW.getTime() - 2 * DAY_MS);

    const report = await readSessionMeshInsights(ORG, { to });

    expect(report.window).toEqual({
      from: new Date(to.getTime() - 30 * DAY_MS).toISOString(),
      to: to.toISOString(),
    });
  });

  it("uses a supplied start unchanged", async () => {
    arrangeRows();
    const from = new Date(NOW.getTime() - 5 * DAY_MS);

    const report = await readSessionMeshInsights(ORG, { from });

    expect(report.window.from).toBe(from.toISOString());
  });

  it("throws before querying for a window outside retention", async () => {
    await expect(
      readSessionMeshInsights(ORG, {
        from: new Date(NOW.getTime() - 120 * DAY_MS),
      })
    ).rejects.toThrow("Invalid bounded Session Mesh reporting window");
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(meshDbState.calls).toEqual([]);
  });
});

describe("readSessionMeshInsights scope", () => {
  it("filters every aggregate by the selected user", async () => {
    arrangeRows();

    const report = await readSessionMeshInsights(ORG, undefined, USER);

    const [totalsQuery, trendQuery] = queries();
    // Five arms now: presence, the delivery cohort, the attempted subquery over
    // the same table, the feedback population and the request author.
    expect(totalsQuery?.values.filter((value) => value === USER)).toHaveLength(
      5
    );
    expect(trendQuery?.values.filter((value) => value === USER)).toHaveLength(
      3
    );
    for (const filter of [
      "AND user_id = ?::uuid",
      "AND recipient_user_id = ?::uuid",
      "AND request.author_user_id = ?::uuid",
    ]) {
      expect(totalsQuery?.sql).toContain(filter);
    }
    expect(trendQuery?.sql).toContain("AND author_user_id = ?::uuid");
    expect(trendQuery?.sql).toContain("AND recipient_user_id = ?::uuid");
    expect(report.scope).toEqual({ kind: InsightsScope.Me, userId: USER });
    expect(
      report.provenance.notes.some((note) =>
        note.startsWith(INDIVIDUAL_NOTE_PREFIX)
      )
    ).toBe(true);
  });

  it("applies no user filter in organization scope", async () => {
    arrangeRows();

    const report = await readSessionMeshInsights(ORG);

    for (const query of queries()) {
      expect(query.sql).not.toContain(USER_FILTER);
      expect(query.values).toContain(ORG);
    }
    expect(report.scope).toEqual({ kind: InsightsScope.Org });
    expect(report.provenance.notes).toHaveLength(8);
    expect(
      report.provenance.notes.some((note) =>
        note.startsWith(INDIVIDUAL_NOTE_PREFIX)
      )
    ).toBe(false);
  });
});

describe("readSessionMeshInsights totals", () => {
  it("maps the aggregate row and trend into the wire report", async () => {
    arrangeRows();

    const report = await readSessionMeshInsights(ORG);

    expect(report).toMatchObject({
      trend,
      participation: { active: 2, eligible: 3 },
      deliveries: {
        attempted: 4,
        delivered: 5,
        acknowledged: 6,
        useful: 1,
        conflictsResolved: 1,
        // ISS-11435: the value ternary's own denominator, summed from the three
        // judgement kinds rather than reported separately by the query.
        judged: 6,
        notUseful: 2,
        cantTell: 3,
        recipientActions: 4,
      },
      requestResponseLatencyMs: 1500,
      estimatedTimeSavedMinutes: null,
      estimatedCostSavedUsd: null,
      coordinationOverheadMs: null,
      provenance: { availability: "measured" },
    });
  });

  it.each([
    [{ estimatedTimeSavedMinutes: 10 }],
    [{ estimatedCostSavedUsd: 2.5 }],
  ])(
    "reports partial availability when a savings estimate exists (%o)",
    async (overrides) => {
      arrangeRows([totals(overrides)]);

      const report = await readSessionMeshInsights(ORG);

      expect(report.provenance.availability).toBe("partial");
    }
  );

  it("refuses to publish totals that contain invalid attributions", async () => {
    arrangeRows([totals({ invalidAttributions: 1 })]);

    await expect(readSessionMeshInsights(ORG)).rejects.toThrow(
      "Invalid persisted Session Mesh attribution"
    );
  });

  it("rejects an aggregate result that is not exactly one row", async () => {
    arrangeRows([]);

    // Zod's array(...).length(1) validation failure, not the downstream
    // "Invalid persisted Session Mesh attribution" guard — a mutant that
    // drops the length(1) constraint would still throw (totals ends up
    // undefined, tripping the `!totals` check), but with a different
    // message, so this pins the specific arm rather than any throw at all.
    await expect(readSessionMeshInsights(ORG)).rejects.toThrow(
      "expected array to have"
    );
  });
});

describe("sessionMeshService.insights", () => {
  it("delegates to the reader with the same window and user", async () => {
    arrangeRows();
    const from = new Date(NOW.getTime() - 7 * DAY_MS);

    const report = await sessionMeshService.insights(
      ORG,
      { from, to: NOW },
      USER
    );

    expect(report.window).toEqual({
      from: from.toISOString(),
      to: NOW.toISOString(),
    });
    expect(report.scope).toEqual({ kind: InsightsScope.Me, userId: USER });
  });
});

describe("round-trip savings (ISS-11756)", () => {
  it("prices a round-trip from the org's own attributed cost", async () => {
    arrangeRows(undefined, undefined, [
      costRow({ estimatedCostUsd: 430, pricedRoundTrips: 1000 }),
    ]);

    const report = await readSessionMeshInsights(ORG);

    expect(report.savings?.costPerRoundTripUsd).toBeCloseTo(0.43, 10);
  });

  it("multiplies savings over ENGAGED deliveries, not every delivery", async () => {
    arrangeRows([totals({ delivered: 5000, acknowledged: 6 })]);

    const report = await readSessionMeshInsights(ORG);

    expect(report.savings?.engagedDeliveries).toBe(6);
  });

  it("publishes the price even when cost coverage is partial", async () => {
    // Partial coverage is a shortfall to report beside the figure, never a
    // reason to withhold it.
    arrangeRows(undefined, undefined, [
      costRow({
        roundTrips: 1000,
        pricedRoundTrips: 250,
        estimatedCostUsd: 100,
      }),
    ]);

    const report = await readSessionMeshInsights(ORG);

    expect(report.savings?.costPerRoundTripUsd).toBeCloseTo(0.4, 10);
  });

  it("reports an unknown price as null, never as a free round-trip", async () => {
    arrangeRows(undefined, undefined, [
      costRow({ pricedRoundTrips: 0, estimatedCostUsd: null }),
    ]);

    const report = await readSessionMeshInsights(ORG);

    expect(report.savings?.costPerRoundTripUsd).toBeNull();
    expect(report.savings?.median).toBeNull();
  });

  it("reports trips-saved as unknown until its producer exists (ISS-11761)", async () => {
    arrangeRows();

    const report = await readSessionMeshInsights(ORG);

    expect(report.savings?.tripsSaved).toEqual({
      median: null,
      mean: null,
      p90: null,
      observations: 0,
    });
    // No distribution means no projection — and null, not a guessed zero.
    expect(report.savings?.median).toBeNull();
    expect(report.savings?.mean).toBeNull();
    expect(report.savings?.p90).toBeNull();
  });

  it("scopes the cost read to the organization", async () => {
    arrangeRows();

    await readSessionMeshInsights(ORG);

    const costQuery = queries()[2];
    expect(costQuery.sql).toContain("agent_session_token_events");
    expect(costQuery.sql).toContain("organization_id = ?::uuid");
  });

  it("filters the cost read by the session's creator in individual scope (ISS-12251 D-4)", async () => {
    arrangeRows();

    await readSessionMeshInsights(ORG, undefined, USER);

    const costQuery = queries()[2];
    expect(costQuery.sql).toContain("a.created_by_id = ?::uuid");
    expect(costQuery.sql).not.toContain("assignee_id");
    expect(costQuery.values).toContain(USER);
  });
});

describe("transaction budget (ISS-11812)", () => {
  it("buckets trend days in UTC, matching the window the card states", async () => {
    arrangeRows();

    await readSessionMeshInsights(ORG);

    // `to_char` on a timestamptz renders in the SESSION TimeZone and nothing
    // pins that to UTC, so without this the day buckets could drift off the UTC
    // window the provenance note promises.
    const [, trendQuery] = queries();
    expect(trendQuery?.sql).not.toMatch(UNZONED_TO_CHAR);
    expect(trendQuery?.sql).toContain("AT TIME ZONE 'UTC'");
  });

  it("bounds the judged join on the event side", async () => {
    arrangeRows();

    await readSessionMeshInsights(ORG);

    // Same defect as first_replies: no time bound at all, so the join read every
    // metric event the organization had ever recorded.
    expect(queries()[0]?.sql).toContain("event.created_at BETWEEN");
  });

  it("bounds first_replies on the request side, not just the reply side", async () => {
    arrangeRows();

    await readSessionMeshInsights(ORG);

    // Without this bound the self-join considered EVERY request the org had
    // ever recorded, regardless of the window asked for, which is what pushed
    // the transaction past Prisma's 5s interactive budget and 500'd org scope.
    const [totalsQuery] = queries();
    expect(totalsQuery?.sql).toContain("request.created_at BETWEEN");
  });

  it("keeps the round-trip cost read out of the repeatable-read transaction", async () => {
    arrangeRows();

    await readSessionMeshInsights(ORG);

    const kinds = meshDbState.calls.map((call) => call.kind);
    expect(kinds).toEqual(["tx", "plain", "plain"]);
    // Exactly one transaction: the cost read must not reopen one of its own
    // either, or it re-enters a budget this fix exists to leave.
    expect(kinds.filter((kind) => kind === "tx")).toHaveLength(1);
  });
});

describe("funnel instrumentation (ISS-11812)", () => {
  it("emits the funnel so a stage collapsing is one Datadog query", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    arrangeRows([
      totals({
        delivered: 100,
        routed: 40,
        acknowledged: 10,
        useful: 2,
        notUseful: 1,
        cantTell: 0,
      }),
    ]);

    await readSessionMeshInsights(ORG);

    const emitted = info.mock.calls
      .map(([line]) => line)
      .filter((line): line is string => typeof line === "string")
      .map((line) => JSON.parse(line))
      .find((payload) => payload.event === "session_mesh_funnel");
    expect(emitted).toMatchObject({
      level: "info",
      status: "ok",
      scope: "org",
      delivered: 100,
      routed: 40,
      engaged: 10,
      judged: 3,
    });
    expect(emitted.routedRate).toBeCloseTo(0.4, 10);
    expect(emitted.engagedRate).toBeCloseTo(0.25, 10);
    expect(emitted.judgedRate).toBeCloseTo(0.3, 10);
    info.mockRestore();
  });

  it("reports a stage rate as null, never 0%, when its denominator is empty", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    arrangeRows([
      totals({
        delivered: 0,
        routed: 0,
        acknowledged: 0,
        useful: 0,
        notUseful: 0,
        cantTell: 0,
      }),
    ]);

    await readSessionMeshInsights(ORG);

    const emitted = info.mock.calls
      .map(([line]) => line)
      .filter((line): line is string => typeof line === "string")
      .map((line) => JSON.parse(line))
      .find((payload) => payload.event === "session_mesh_funnel");
    // A quiet window must not look like a stage converting at zero percent.
    expect(emitted.routedRate).toBeNull();
    expect(emitted.engagedRate).toBeNull();
    info.mockRestore();
  });
});

describe("collision density (ISS-11755)", () => {
  it("derives pairs and per-pair density from the day's active agents", async () => {
    arrangeRows(undefined, undefined, undefined, [
      densityRow({ activeAgents: 5, detected: 25 }),
    ]);

    const report = await readSessionMeshInsights(ORG);

    // 5 agents -> 10 pairs; 25 detected -> 2.5 per pair.
    expect(report.collisionDensity?.[0]).toMatchObject({
      pairs: 10,
      density: 2.5,
    });
  });

  it("reports density as null below two agents, never as zero contention", async () => {
    arrangeRows(undefined, undefined, undefined, [
      densityRow({ activeAgents: 1, detected: 0 }),
    ]);

    const report = await readSessionMeshInsights(ORG);

    // One agent cannot collide with itself; 0 would read as a quiet busy day.
    expect(report.collisionDensity?.[0]?.density).toBeNull();
    expect(report.collisionDensity?.[0]?.pairs).toBe(0);
  });

  it("counts a collision only where a real path overlap was persisted", async () => {
    arrangeRows();

    await readSessionMeshInsights(ORG);

    const densityQuery = queries()[3];
    expect(densityQuery?.sql).toContain("relevance->'pathOverlap'");
    expect(densityQuery?.sql).toContain("jsonb_array_length");
    // Buckets must match the UTC window the card reports.
    expect(densityQuery?.sql).toContain("AT TIME ZONE 'UTC'");
  });

  it("counts a symbol-only overlap, which ISS-11755 defines as a collision", async () => {
    arrangeRows();

    await readSessionMeshInsights(ORG);

    // "a delivery whose relevance carries a non-empty pathOverlap OR
    // symbolOverlap". A ticket-slug-only overlap read as zero before.
    expect(queries()[3]?.sql).toContain("relevance->'symbolOverlap'");
  });

  it("buckets detection on queued_at, not on the surfacing timestamp", async () => {
    arrangeRows();

    await readSessionMeshInsights(ORG);

    const densityQuery = queries()[3];
    // Detection happens at publish. Bucketing on delivered_at dropped every
    // held row (digest-only subscriber, rank shared_artifact) from the series.
    expect(densityQuery?.sql).toContain("to_char(queued_at AT TIME ZONE 'UTC'");
    expect(densityQuery?.sql).toContain("AND queued_at BETWEEN");
    expect(densityQuery?.sql).not.toContain("AND delivered_at BETWEEN");
    expect(densityQuery?.sql).toContain("delivered_at IS NOT NULL");
  });

  it("keeps overlap kinds separate instead of collapsing them into one count", async () => {
    arrangeRows();

    const report = await readSessionMeshInsights(ORG);

    // The relevance keys `relevanceFor` persists, asserted through the query's
    // bound VALUES rather than the stubbed row: a toMatchObject on the stub
    // alone stays green when the projection is replaced by a literal 0.
    const densityQuery = queries()[3];
    for (const key of RELEVANCE_OVERLAP_KEYS) {
      expect(densityQuery?.values).toContain(key);
    }
    // A shared branch and a shared file are different events with different
    // costs (ISS-11755 item 1), so each kind reaches the wire separately.
    expect(report.collisionDensity?.[0]).toMatchObject({
      pathCollisions: 18,
      symbolCollisions: 9,
      branchCollisions: 4,
      pullRequestCollisions: 2,
      artifactCollisions: 1,
      blockingCollisions: 0,
    });
  });

  it("scopes the density series to the user on individual scope", async () => {
    arrangeRows();

    await readSessionMeshInsights(ORG, undefined, USER);

    // Every other figure in the report is recipient-filtered on Me scope; an
    // org-wide density under an individual scope misreports whose contention
    // it is.
    expect(queries()[3]?.sql).toContain("AND recipient_user_id = ?::uuid");
    expect(queries()[3]?.values).toContain(USER);
  });
});

describe("the funnel's routed stage (ISS-11755)", () => {
  it("counts deliveries that named a subject, not every non-empty relevance", async () => {
    arrangeRows();

    await readSessionMeshInsights(ORG);

    const totalsQuery = queries()[0];
    // `publish` writes a non-empty relevance on every row it creates, so
    // `relevance <> '{}'` sat at ~1.0 and the stage could never drop.
    expect(totalsQuery?.sql).not.toContain("relevance <> '{}'");
    expect(totalsQuery?.sql).toContain("relevance->'symbolOverlap'");
  });
});
