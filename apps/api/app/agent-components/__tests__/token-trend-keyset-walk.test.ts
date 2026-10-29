/**
 * ISS-9851: the token-trend read pages, so every session in the window is
 * reachable (PRD-666 — "a retained prefix is never the population").
 *
 * `token-trend-row-ceiling.test.ts` owns what ONE page does with the ceiling.
 * This file owns where the NEXT page starts: the cursor names the SESSION the
 * page ended on, so a resumed read can never split a session, repeat one, or
 * stall on one it cannot return.
 *
 * The double EXECUTES the keyset predicate (see `./support/token-trend-row-store`),
 * so a cursor that resumes one row or one session early observably returns the
 * wrong rows rather than passing on a fixture that never crossed the bound.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import {
  installRowStore,
  ORG,
  PINNED_NOW_MS,
  rowsPerSession,
  SLUG,
  sessionRows,
  sessionUuid,
  type UsageRowFixture,
  walkProblems,
} from "@/__tests__/support/agent-components/token-trend-row-store.test-db";
import { analyticsService, type TokenTrendQuery } from "../analytics-service";
import { MAX_TOKEN_TREND_USAGE_ROWS } from "../analytics-validators";
import { ROLLED_UP_SUBAGENT_KEY } from "../subagent-identity";
import {
  decodeTokenTrendCursor,
  encodeTokenTrendCursor,
} from "../token-trend-cursor";

/** A walk over a fixture this size must terminate long before this. */
const MAX_WALK_PAGES = 12;

const OVERSIZE_SESSION = sessionUuid(3_000_001);
const TIE_SESSION_A = sessionUuid(4_000_001);
const TIE_SESSION_B = sessionUuid(4_000_002);

function install(rows: UsageRowFixture[]) {
  return installRowStore(mocks.withDb, rows);
}

async function readPage(
  query: TokenTrendQuery,
  slug = SLUG
): Promise<TokenTrendResponse> {
  const page = await analyticsService.fetchTokenTrend(ORG, slug, query);
  if (!page) {
    throw new Error("the slug did not resolve");
  }
  return page;
}

/**
 * The session a page ended on — the OLDEST one it carries. Points come back
 * ascending by session start, so that is the head of the array, and it is the
 * session the cursor must name.
 */
function boundaryPointOf(page: TokenTrendResponse) {
  return page.points[0];
}

function cursorOf(raw: string) {
  const cursor = decodeTokenTrendCursor(raw);
  if (!cursor) {
    throw new Error(`this endpoint minted a cursor it cannot read: ${raw}`);
  }
  return cursor;
}

/** Follow `nextCursor` to exhaustion, exactly as a client is expected to. */
async function walk(
  query: TokenTrendQuery = {},
  slug = SLUG
): Promise<TokenTrendResponse[]> {
  const pages: TokenTrendResponse[] = [];
  let next: string | undefined;
  for (let page = 0; page < MAX_WALK_PAGES; page++) {
    const current = await analyticsService.fetchTokenTrend(
      ORG,
      slug,
      next ? { ...query, cursor: cursorOf(next) } : query
    );
    if (!current) {
      throw new Error("the slug did not resolve");
    }
    pages.push(current);
    if (!current.nextCursor) {
      return pages;
    }
    next = current.nextCursor;
  }
  throw new Error("the walk never reached a page without a cursor");
}

/** `sessions` sessions of `branches` rows each, newest first. */
function ladderRows(sessions: number, branches: number): UsageRowFixture[] {
  const rows: UsageRowFixture[] = [];
  for (let index = 0; index < sessions; index++) {
    rows.push(
      ...sessionRows(
        sessionUuid(index),
        new Date(PINNED_NOW_MS - index * 1000),
        branches
      )
    );
  }
  return rows;
}

describe("ISS-9851 — the next page starts at the next session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
  });
  afterEach(() => vi.useRealTimers());

  it("resumes at the session after the one the page ended on", async () => {
    // 5,003 four-row sessions: the ceiling falls exactly at session 4,999's
    // last row, so page 1 holds 5,000 whole sessions and three remain.
    const branches = 4;
    const pageSessions = MAX_TOKEN_TREND_USAGE_ROWS / branches;
    install(ladderRows(pageSessions + 3, branches));

    const first = await readPage({});
    const boundary = boundaryPointOf(first);
    expect(first.nextCursor).toBeDefined();
    expect(cursorOf(first.nextCursor ?? "")).toEqual({
      sessionStartedAtMs: Date.parse(boundary?.sessionStartedAt ?? ""),
      agentSessionId: boundary?.sessionId,
    });

    const second = await readPage({ cursor: cursorOf(first.nextCursor ?? "") });

    // Strictly after: the boundary session is not repeated, and the session
    // that was one past the ceiling is the first thing the next page carries.
    expect(second.points.map((point) => point.sessionId)).toEqual([
      sessionUuid(pageSessions + 2),
      sessionUuid(pageSessions + 1),
      sessionUuid(pageSessions),
    ]);
    expect(
      second.points.some((point) => point.sessionId === boundary?.sessionId)
    ).toBe(false);
  });

  it("resumes at the tied session the page ended on, not past it", async () => {
    // Two sessions share one `sessionStartedAt`, so the cursor's timestamp
    // alone cannot separate them: only the `agentSessionId >` arm can. A cursor
    // that compared the timestamp alone would skip B entirely.
    const headSessions = (MAX_TOKEN_TREND_USAGE_ROWS - 2) / 2;
    const rows = ladderRows(headSessions, 2);
    const tieStartedAt = new Date(PINNED_NOW_MS - headSessions * 1000);
    rows.push(
      ...sessionRows(TIE_SESSION_A, tieStartedAt, 3),
      ...sessionRows(TIE_SESSION_B, tieStartedAt, 3)
    );
    install(rows);

    const first = await readPage({});
    expect(boundaryPointOf(first)?.sessionId).toBe(TIE_SESSION_A);

    const second = await readPage({ cursor: cursorOf(first.nextCursor ?? "") });

    expect(second.points.map((point) => point.sessionId)).toEqual([
      TIE_SESSION_B,
    ]);
    expect(second.points[0]?.componentInvocations).toBe(3);
  });

  it("reaches every session in the window, each exactly once and whole", async () => {
    const branches = 4;
    const rows = ladderRows(
      MAX_TOKEN_TREND_USAGE_ROWS / branches + 3,
      branches
    );
    install(rows);

    const pages = await walk();

    expect(pages).toHaveLength(2);
    expect(walkProblems(pages, rowsPerSession(rows))).toEqual([]);
    // The last page is complete: nothing withheld, so nothing claims it was.
    expect(pages.at(-1)?.truncated).toBeUndefined();
    expect(pages.at(-1)?.nextCursor).toBeUndefined();
  });

  it("catches a resume that starts one session early", async () => {
    // The counterfactual for the walk checker itself: a cursor built from the
    // session BEFORE the boundary — what a `>=` comparison, or a cursor taken
    // from the last KEPT session, would produce — repeats a session, and the
    // checker has to say so rather than pass.
    const branches = 4;
    const rows = ladderRows(
      MAX_TOKEN_TREND_USAGE_ROWS / branches + 3,
      branches
    );
    install(rows);

    const first = await readPage({});
    const oneEarly = first.points[1];
    const resumed = await readPage({
      cursor: {
        sessionStartedAtMs: Date.parse(oneEarly?.sessionStartedAt ?? ""),
        agentSessionId: oneEarly?.sessionId ?? "",
      },
    });

    const problems = walkProblems([first, resumed], rowsPerSession(rows));
    expect(problems).toContain(
      `duplicate ${boundaryPointOf(first)?.sessionId}`
    );
  });

  it("catches a session summed from part of its rows", () => {
    // The other half of the checker's teeth, on a synthetic page: a session
    // whose point counts fewer invocations than the fixture has rows is a
    // partial total, which is the ISS-6887 defect this walk must never revive.
    const rows = ladderRows(2, 3);

    const problems = walkProblems(
      [
        {
          points: [{ sessionId: sessionUuid(0), componentInvocations: 2 }],
        },
        {
          points: [{ sessionId: sessionUuid(1), componentInvocations: 3 }],
        },
      ],
      rowsPerSession(rows)
    );

    expect(problems).toEqual([
      `partial ${sessionUuid(0)}: 2 of 3 rows counted`,
    ]);
  });

  it("carries a session too large for one read as its full sum, mid-walk", async () => {
    // A session holding more rows than one read can load cannot be completed
    // row by row. It is summed in the database instead, so it reaches the chart
    // whole, and the cursor moves past it so the older sessions follow.
    const headSessions = (MAX_TOKEN_TREND_USAGE_ROWS - 2) / 2;
    const rows = ladderRows(headSessions, 2);
    const oversizeStartedAt = new Date(PINNED_NOW_MS - headSessions * 1000);
    rows.push(
      ...sessionRows(
        OVERSIZE_SESSION,
        oversizeStartedAt,
        MAX_TOKEN_TREND_USAGE_ROWS + 1
      ),
      ...sessionRows(
        sessionUuid(5_000_001),
        new Date(oversizeStartedAt.getTime() - 1000),
        2
      )
    );
    install(rows);

    const pages = await walk();

    // Every session, the oversize one included, each counted from ALL its rows
    // — `walkProblems` reports a `partial` for a sum taken over a prefix.
    expect(walkProblems(pages, rowsPerSession(rows))).toEqual([]);
    const oversize = pages
      .flatMap((page) => page.points)
      .find((point) => point.sessionId === OVERSIZE_SESSION);
    expect(oversize?.componentInvocations).toBe(MAX_TOKEN_TREND_USAGE_ROWS + 1);
  });

  it("narrows the boundary aggregate by the same predicate on a resumed page", async () => {
    const branches = 4;
    const rows = ladderRows(
      (MAX_TOKEN_TREND_USAGE_ROWS / branches) * 2 + 3,
      branches
    );
    const store = install(rows);
    const first = await readPage({});
    store.calls.length = 0;

    await readPage({
      cursor: cursorOf(first.nextCursor ?? ""),
      userId: "user-42",
    });

    const [page, completion] = store.calls;
    // Same question, narrowed by one session — including the keyset arm, so
    // the aggregate can never reach back before the cursor.
    expect(completion?.method).toBe("groupBy");
    expect(completion?.args.where).toEqual({
      ...page?.args.where,
      agentSessionId: expect.any(String),
    });
  });

  it("asks whether anything is older only when the probe row cannot say", async () => {
    // Page one's probe row belongs to the session after the boundary, so the
    // existence of an older page is already proven and no probe is issued.
    // Page two ends on a boundary session whose own rows fill the probe, so the
    // read has to ask — and finds the last session, which page three carries.
    const branches = 4;
    const pageSessions = MAX_TOKEN_TREND_USAGE_ROWS / branches;
    const rows = ladderRows(pageSessions * 2 - 1, branches);
    const lastStartedAt = new Date(
      PINNED_NOW_MS - (pageSessions * 2 - 1) * 1000
    );
    rows.push(
      ...sessionRows(
        sessionUuid(pageSessions * 2 - 1),
        lastStartedAt,
        branches + 1
      ),
      ...sessionRows(
        sessionUuid(pageSessions * 2),
        new Date(lastStartedAt.getTime() - 1000),
        1
      )
    );
    const store = install(rows);

    const pages = await walk();

    expect(pages).toHaveLength(3);
    expect(walkProblems(pages, rowsPerSession(rows))).toEqual([]);
    expect(store.calls.map((call) => call.method)).toEqual([
      "findMany",
      "groupBy",
      "findMany",
      "groupBy",
      "findFirst",
      "findMany",
    ]);
    // The probe resumes exactly where the cursor it decides for would.
    const [, , , , probe] = store.calls;
    expect(probe?.args.where).toEqual(
      expect.objectContaining({
        AND: [expect.objectContaining({ OR: expect.any(Array) })],
      })
    );
  });

  it("keeps every scope the read already had when a cursor is supplied", async () => {
    // The cursor is opaque and unsigned, so it is safe only because it is
    // AND-ed under the org/identity/window scoping rather than replacing it.
    const store = install(ladderRows(2, 2));

    await readPage({
      cursor: {
        sessionStartedAtMs: PINNED_NOW_MS,
        agentSessionId: sessionUuid(9),
      },
      userId: "user-42",
    });

    const where = store.calls[0]?.args.where as {
      componentKind?: string;
      componentKeyNormalized?: { in: string[] };
      session?: {
        artifact?: { organizationId?: string; createdById?: string };
        sessionStartedAt?: { gte?: Date };
      };
      AND?: unknown[];
    };
    expect(where.componentKind).toBe(AgentComponentKind.Command);
    expect(where.componentKeyNormalized).toEqual({ in: ["build"] });
    expect(where.session?.artifact?.organizationId).toBe(ORG);
    expect(where.session?.artifact?.createdById).toBe("user-42");
    expect(where.session?.sessionStartedAt?.gte).toBeInstanceOf(Date);
    expect(where.AND).toHaveLength(1);
  });

  it("still offers the cursor when a page's rows are all filtered out", async () => {
    // The rolled-up general-purpose identity over-matches in SQL and tightens
    // in JS, so a full page can come back holding nothing. Dropping the cursor
    // there would end the walk on the hottest component there is, with older
    // sessions still unread.
    const rows: UsageRowFixture[] = [];
    const sessions = (MAX_TOKEN_TREND_USAGE_ROWS + 2) / 2;
    for (let index = 0; index < sessions; index++) {
      rows.push(
        ...sessionRows(
          sessionUuid(index),
          new Date(PINNED_NOW_MS - index * 1000),
          2,
          (branch) => `${sessionUuid(index)}-row-${branch}`,
          // Over-matched by the SQL prefix, rejected by the JS tightening: the
          // instance label must be hex.
          "claude subagent zz"
        )
      );
    }
    install(rows);

    const page = await readPage({}, `subagent::${ROLLED_UP_SUBAGENT_KEY}`);

    expect(page.points).toEqual([]);
    expect(page.nextCursor).toBeDefined();
    expect(page.truncated).toBe(true);
  });

  it("reads exactly as it does today when no cursor is supplied", async () => {
    const store = install(ladderRows(3, 2));

    const page = await readPage({});

    expect(store.calls[0]?.args.where).not.toHaveProperty("AND");
    expect(page.nextCursor).toBeUndefined();
    expect(page.points).toHaveLength(3);
  });
});

describe("ISS-9851 — the rolled-up identity slug still pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_NOW_MS));
  });
  afterEach(() => vi.useRealTimers());

  it("walks a rolled-up subagent component to exhaustion", async () => {
    const rows: UsageRowFixture[] = [];
    const sessions = MAX_TOKEN_TREND_USAGE_ROWS / 2 + 2;
    for (let index = 0; index < sessions; index++) {
      rows.push(
        ...sessionRows(
          sessionUuid(index),
          new Date(PINNED_NOW_MS - index * 1000),
          2,
          (branch) => `${sessionUuid(index)}-row-${branch}`,
          ROLLED_UP_SUBAGENT_KEY
        )
      );
    }
    install(rows);

    const pages = await walk({}, `subagent::${ROLLED_UP_SUBAGENT_KEY}`);

    expect(walkProblems(pages, rowsPerSession(rows))).toEqual([]);
  });
});

describe("ISS-9851 — the cursor codec round-trips a real page position", () => {
  it("re-reads a cursor this endpoint minted", () => {
    const cursor = {
      sessionStartedAtMs: PINNED_NOW_MS,
      agentSessionId: sessionUuid(7),
    };

    expect(decodeTokenTrendCursor(encodeTokenTrendCursor(cursor))).toEqual(
      cursor
    );
  });
});
