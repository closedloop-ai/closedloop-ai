/**
 * ISS-6887 regression suite: the token-trend row ceiling must never cut a
 * session in half, and the window it applied must be visible on the wire.
 *
 * `MAX_TOKEN_TREND_USAGE_ROWS` bounds RAW usage rows, but the trend aggregates
 * those rows BY SESSION — FEA-2990 gave a component one usage row per git branch
 * per session, and the session's `componentInvocations` is the sum across them.
 * A bare `take` therefore cuts mid-session whenever the ceiling lands inside a
 * multi-branch session's rows, and that session's point was emitted as a
 * confident total computed from a partial row set: a WRONG number, not a missing
 * one. Nothing on the response said either had happened, and the read's default
 * 90-day lower bound was equally invisible.
 *
 * The double lives in `./support/token-trend-row-store` and actually EXECUTES
 * the query — see its header. A fixture below the ceiling passes with or
 * without the fix, so every case below crosses it.
 *
 * What ONE page does with the ceiling is this file. Where the NEXT page starts
 * is `token-trend-keyset-walk.test.ts` (ISS-9851).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

import {
  installRowStore,
  ORG,
  PINNED_NOW_MS,
  SLUG,
  sessionRows,
  sessionUuid,
  type UsageRowFixture,
} from "@/__tests__/support/agent-components/token-trend-row-store.test-db";
import { analyticsService } from "../analytics-service";
import {
  DEFAULT_TOKEN_TREND_LOOKBACK_DAYS,
  MAX_TOKEN_TREND_USAGE_ROWS,
} from "../analytics-validators";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Usage rows one session contributes — FEA-2990's per-git-branch rows. Three is
 * the smallest count that lets the ceiling land strictly INSIDE a session.
 */
const BRANCHES_PER_SESSION = 3;

/**
 * Head sessions placed entirely above the ceiling, sized so the NEXT session's
 * rows straddle it: `HEAD_ROWS + 2` is the last row `take` retains, leaving that
 * session's third row on the far side. Derived from the ceiling so the fixture
 * keeps biting if the ceiling is ever retuned instead of going vacuous.
 */
const HEAD_SESSIONS = (MAX_TOKEN_TREND_USAGE_ROWS - 2) / BRANCHES_PER_SESSION;

const BOUNDARY_SESSION = sessionUuid(1_000_001);
const TAIL_SESSION = sessionUuid(1_000_002);
/** Two sessions that started in the SAME instant — `a` sorts before `b`. */
const TIE_SESSION_A = sessionUuid(2_000_001);
const TIE_SESSION_B = sessionUuid(2_000_002);

function install(rows: UsageRowFixture[]) {
  return installRowStore(mocks.withDb, rows);
}

/**
 * Head sessions newest-first, then the session astride the ceiling, then one
 * session strictly below it. `agentSessionId` is NOT the sort key here — every
 * session gets a distinct `sessionStartedAt` — so ordering is by recency alone,
 * as production reads it.
 */
function aboveCeilingRows(): UsageRowFixture[] {
  const rows: UsageRowFixture[] = [];
  for (let index = 0; index < HEAD_SESSIONS; index++) {
    rows.push(
      ...sessionRows(
        sessionUuid(index),
        new Date(PINNED_NOW_MS - index * 1000),
        BRANCHES_PER_SESSION
      )
    );
  }
  rows.push(
    ...sessionRows(
      BOUNDARY_SESSION,
      new Date(PINNED_NOW_MS - HEAD_SESSIONS * 1000),
      BRANCHES_PER_SESSION
    ),
    ...sessionRows(
      TAIL_SESSION,
      new Date(PINNED_NOW_MS - (HEAD_SESSIONS + 1) * 1000),
      BRANCHES_PER_SESSION
    )
  );
  return rows;
}

describe("ISS-6887 — the row ceiling never splits a session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
  });
  afterEach(() => vi.useRealTimers());

  it("reports the complete invocation total for the session astride the ceiling", async () => {
    install(aboveCeilingRows());

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    const boundary = result?.points.find(
      (point) => point.sessionId === BOUNDARY_SESSION
    );
    // Pre-fix the `take` kept 2 of this session's 3 branch rows and the point
    // reported `componentInvocations: 2` — a total summed over a prefix.
    expect(boundary?.componentInvocations).toBe(BRANCHES_PER_SESSION);
  });

  it("still drops the sessions below the ceiling rather than raising it", async () => {
    install(aboveCeilingRows());

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    // Completing the boundary session must not turn the ceiling off: the older
    // session stays out of THIS page. ISS-9851 reaches it through the cursor,
    // never by widening the read.
    expect(
      result?.points.some((point) => point.sessionId === TAIL_SESSION)
    ).toBe(false);
  });

  it("states truncation on the response when the ceiling bound", async () => {
    install(aboveCeilingRows());

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    expect(result?.truncated).toBe(true);
  });

  it("omits truncation when the read fit under the ceiling", async () => {
    install(sessionRows("session-small", new Date(PINNED_NOW_MS), 3));

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    expect(result?.points).toHaveLength(1);
    // Omitted, never `false`, so a reader predating the field sees today's shape.
    expect(result?.truncated).toBeUndefined();
    expect("truncated" in (result ?? {})).toBe(false);
  });

  it("keeps a page one row short of the ceiling whole and unflagged", async () => {
    // The other side of the exact-cap boundary: one row below the ceiling was
    // never at risk, and pins that the probe row did not shift the bound by one.
    const rows: UsageRowFixture[] = [];
    const shortBranches = 4;
    const sessions = MAX_TOKEN_TREND_USAGE_ROWS / shortBranches - 1;
    for (let index = 0; index < sessions; index++) {
      rows.push(
        ...sessionRows(
          sessionUuid(index),
          new Date(PINNED_NOW_MS - index * 1000),
          shortBranches
        )
      );
    }
    rows.push(
      ...sessionRows(
        sessionUuid(sessions),
        new Date(PINNED_NOW_MS - sessions * 1000),
        shortBranches - 1
      )
    );
    install(rows);

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    expect(result?.truncated).toBeUndefined();
    expect(result?.points).toHaveLength(sessions + 1);
  });

  it("keeps a page that exactly fills the ceiling whole and unflagged", async () => {
    // Exactly `MAX` rows exist. Nothing was dropped, so nothing may claim it
    // was: inferring truncation from `length === take` cannot tell this page
    // from a cut one, which is why the read probes one row past the bound.
    const rows: UsageRowFixture[] = [];
    const exactBranches = 4;
    const sessions = MAX_TOKEN_TREND_USAGE_ROWS / exactBranches;
    for (let index = 0; index < sessions; index++) {
      rows.push(
        ...sessionRows(
          sessionUuid(index),
          new Date(PINNED_NOW_MS - index * 1000),
          exactBranches
        )
      );
    }
    install(rows);

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    expect(result?.truncated).toBeUndefined();
    expect(result?.points).toHaveLength(sessions);
  });

  it("keeps the next session out when the ceiling lands exactly at a session end", async () => {
    // ISS-9851 lock-in. The read probes one row PAST the ceiling, and when the
    // ceiling falls exactly at a session END that probe row is the FIRST row of
    // the next session. Slicing it back off is what keeps that session out of
    // the page — and out of the position the walk resumes from. Every other
    // fixture here puts the probe row INSIDE the boundary session, where
    // dropping the slice is equivalent, which is why Stryker left the slice in
    // `analytics-service.ts` surviving.
    const rows: UsageRowFixture[] = [];
    const branches = 4;
    const sessions = MAX_TOKEN_TREND_USAGE_ROWS / branches;
    for (let index = 0; index < sessions; index++) {
      rows.push(
        ...sessionRows(
          sessionUuid(index),
          new Date(PINNED_NOW_MS - index * 1000),
          branches
        )
      );
    }
    rows.push(
      ...sessionRows(
        TAIL_SESSION,
        new Date(PINNED_NOW_MS - sessions * 1000),
        branches
      )
    );
    install(rows);

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    expect(
      result?.points.some((point) => point.sessionId === TAIL_SESSION)
    ).toBe(false);
    expect(result?.points).toHaveLength(sessions);
    expect(result?.truncated).toBe(true);
  });

  it("keeps a boundary session whose own rows exactly fill the ceiling", async () => {
    // The probe reads MAX + 1 rows, so a boundary session of exactly `MAX` rows
    // is the case where the probe row is the boundary's own last row — the
    // aggregate still has to sum every one of them, not the probe's prefix.
    install([
      ...sessionRows(sessionUuid(0), new Date(PINNED_NOW_MS), 2),
      ...sessionRows(
        BOUNDARY_SESSION,
        new Date(PINNED_NOW_MS - 1000),
        MAX_TOKEN_TREND_USAGE_ROWS
      ),
    ]);

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    const boundary = result?.points.find(
      (point) => point.sessionId === BOUNDARY_SESSION
    );
    expect(boundary?.componentInvocations).toBe(MAX_TOKEN_TREND_USAGE_ROWS);
  });

  it("bisects neither of two sessions that started in the same instant", async () => {
    // The contiguity half of the fix. Two sessions share one `sessionStartedAt`
    // and hold INTERLEAVING row ids, so under the pre-fix
    // `[sessionStartedAt desc, id asc]` order their rows alternate and the
    // ceiling cuts the FIRST of them — a session that is not the last one, which
    // the boundary completion can never repair. `agentSessionId` between the two
    // keys is what keeps each session's rows together.
    const rows: UsageRowFixture[] = [];
    // Four rows apiece so the head divides the ceiling exactly and the two tie
    // sessions land astride it: the last four retained rows are theirs.
    const headBranches = 4;
    const headSessions = (MAX_TOKEN_TREND_USAGE_ROWS - 4) / headBranches;
    for (let index = 0; index < headSessions; index++) {
      rows.push(
        ...sessionRows(
          sessionUuid(index),
          new Date(PINNED_NOW_MS - index * 1000),
          headBranches
        )
      );
    }
    const tieStartedAt = new Date(PINNED_NOW_MS - headSessions * 1000);
    rows.push(
      ...sessionRows(
        TIE_SESSION_A,
        tieStartedAt,
        BRANCHES_PER_SESSION,
        (branch) => `tie-row-${branch * 2}`
      ),
      ...sessionRows(
        TIE_SESSION_B,
        tieStartedAt,
        BRANCHES_PER_SESSION,
        (branch) => `tie-row-${branch * 2 + 1}`
      )
    );
    install(rows);

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    const invocationsOf = (sessionId: string) =>
      result?.points.find((point) => point.sessionId === sessionId)
        ?.componentInvocations;
    // Under the pre-fix order the earlier tie session reported 2 of its 3 rows.
    expect(invocationsOf(TIE_SESSION_A)).toBe(BRANCHES_PER_SESSION);
    expect(invocationsOf(TIE_SESSION_B)).toBe(BRANCHES_PER_SESSION);
  });

  it("scopes the boundary aggregate by exactly the first read's predicate", async () => {
    const store = install(aboveCeilingRows());

    await analyticsService.fetchTokenTrend(ORG, SLUG, { userId: "user-42" });

    // The probe row is the boundary session's own last row, so whether
    // TAIL_SESSION exists has to be asked: page read, aggregate, then probe.
    expect(store.calls.map((call) => call.method)).toEqual([
      "findMany",
      "groupBy",
      "findFirst",
    ]);
    const [first, second, third] = store.calls;
    // The aggregate must narrow the SAME question by one session, never
    // re-derive a looser one: org, user, window, kind and componentKey scoping
    // all have to survive, or the second read can admit another org's rows.
    expect(second?.args.where).toEqual({
      ...first?.args.where,
      agentSessionId: BOUNDARY_SESSION,
    });
    expect(first?.args.where).not.toHaveProperty("agentSessionId");
    expect(second?.args).toMatchObject({
      by: ["componentKey"],
      _sum: { invocationCount: true, errorCount: true },
    });
    // The probe asks the SAME question again, narrowed by the keyset arm the
    // cursor it decides for would carry — every other scope intact.
    expect(third?.args.where).toEqual({
      ...first?.args.where,
      AND: [expect.objectContaining({ OR: expect.any(Array) })],
    });
  });

  it("sums a session larger than the ceiling instead of dropping it", async () => {
    // One session whose own rows exceed the ceiling: no row read can return it
    // whole, and ISS-9851 forbids dropping it (every row in the window stays
    // reachable). The aggregate has no row bound, so the point is its full sum.
    install(
      sessionRows(
        BOUNDARY_SESSION,
        new Date(PINNED_NOW_MS),
        MAX_TOKEN_TREND_USAGE_ROWS + 1
      )
    );

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    expect(result?.points).toHaveLength(1);
    expect(result?.points[0]?.componentInvocations).toBe(
      MAX_TOKEN_TREND_USAGE_ROWS + 1
    );
    // Nothing lies past it, so the response is whole: no truncation, no cursor.
    expect(result?.truncated).toBeUndefined();
    expect(result?.nextCursor).toBeUndefined();
  });

  it("does not claim truncation when the window's LAST session straddles the ceiling", async () => {
    // Head rows, then a final session that runs past the ceiling. The probe
    // row is the boundary's own, so the read has to ASK whether anything is
    // older before it can honestly say `truncated` and hand out a cursor —
    // otherwise a whole population reads as a prefix and every follower pays
    // for one empty page.
    const head = 10;
    const store = install([
      ...Array.from({ length: head }, (_unused, index) =>
        sessionRows(
          sessionUuid(index),
          new Date(PINNED_NOW_MS - index * 1000),
          1
        )
      ).flat(),
      ...sessionRows(
        BOUNDARY_SESSION,
        new Date(PINNED_NOW_MS - head * 1000),
        MAX_TOKEN_TREND_USAGE_ROWS
      ),
    ]);

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    expect(store.calls.map((call) => call.method)).toEqual([
      "findMany",
      "groupBy",
      "findFirst",
    ]);
    expect(result?.points).toHaveLength(head + 1);
    expect(result?.truncated).toBeUndefined();
    expect(result?.nextCursor).toBeUndefined();
  });

  it("bounds the read one probe row past the ceiling, in contiguity order", async () => {
    const store = install([]);

    await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    // The bound is still 20,000 rows — the `+ 1` is a probe row the service
    // slices off, and the only way the read can tell a page that exactly fills
    // the ceiling from one the ceiling cut.
    expect(MAX_TOKEN_TREND_USAGE_ROWS).toBe(20_000);
    const probe = store.calls[0];
    expect(probe?.method).toBe("findMany");
    expect(probe?.method === "findMany" && probe.args.take).toBe(
      MAX_TOKEN_TREND_USAGE_ROWS + 1
    );
    // `agentSessionId` sorts BETWEEN recency and the `id` tiebreak so one
    // session's per-branch rows stay contiguous and the `take` can only ever
    // bisect the LAST session — the one the aggregate completes.
    expect(probe?.method === "findMany" && probe.args.orderBy).toEqual([
      { session: { sessionStartedAt: "desc" } },
      { agentSessionId: "asc" },
      { id: "asc" },
    ]);
  });
});

describe("ISS-6887 — the applied window is stated on the response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
  });
  afterEach(() => vi.useRealTimers());

  it("names the defaulted lookback a param-less caller never asked for", async () => {
    install(sessionRows("session-small", new Date(PINNED_NOW_MS), 3));

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {});

    expect(result?.appliedWindow?.since).toBe(
      new Date(
        PINNED_NOW_MS - DEFAULT_TOKEN_TREND_LOOKBACK_DAYS * MS_PER_DAY
      ).toISOString()
    );
    // Unbounded above when the caller supplied no `until`.
    expect(result?.appliedWindow?.until).toBeUndefined();
  });

  it("echoes an explicit window verbatim, including its upper bound", async () => {
    install([]);

    const result = await analyticsService.fetchTokenTrend(ORG, SLUG, {
      since: "2026-01-01T00:00:00Z",
      until: "2026-02-01T00:00:00Z",
    });

    expect(result?.appliedWindow).toEqual({
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
    });
  });
});
