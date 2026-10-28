/**
 * The token-trend row store double, shared by the ISS-6887 ceiling suite and
 * the ISS-9851 keyset-walk suite.
 *
 * Unlike the `token-trend.test.ts` doubles — which return a fixed array
 * whatever is asked of them, and so cannot observe a bound at all — this one
 * EXECUTES the query: the keyset predicate, `where.agentSessionId`, the
 * `orderBy` as requested, and the `take`. That is the whole point: a read that
 * cuts mid-session, or a cursor that resumes in the wrong place, observably
 * returns the wrong rows.
 *
 * Session ids are uuid-shaped because `agentSessionId` is a uuid column and the
 * cursor codec rejects anything else, so a fixture id has to survive a real
 * encode/decode round trip.
 */

import type { vi } from "vitest";

export const ORG = "org-trend-ceiling";
export const SLUG = "command::build";
export const MODEL = "claude-opus-4-5";
export const PINNED_NOW_MS = Date.parse("2026-07-01T00:00:00.000Z");

/**
 * A uuid-shaped session id whose LEXICOGRAPHIC order follows `index` — the same
 * order Postgres gives uuids, so `agentSessionId asc` in a fixture means what it
 * means in the database.
 */
export function sessionUuid(index: number): string {
  const hex = index.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

export type UsageRowFixture = {
  id: string;
  agentSessionId: string;
  componentKey: string;
  invocationCount: number;
  errorCount: number;
  session: {
    artifactId: string;
    sessionStartedAt: Date;
    sessionEndedAt: Date | null;
    artifact: { organizationId: string };
    tokenUsageByModel: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      estimatedCost: number;
    }>;
    usageRollup: { runtimeMs: number } | null;
  };
};

/**
 * Rows for one session, all sharing its `sessionStartedAt`. `rowId` exists so a
 * tie fixture can give two sessions INTERLEAVING row ids — the only way to make
 * the `agentSessionId` sort key observable.
 */
export function sessionRows(
  agentSessionId: string,
  startedAt: Date,
  branches: number,
  rowId: (branch: number) => string = (branch) =>
    `${agentSessionId}-row-${branch}`,
  componentKey = "build"
): UsageRowFixture[] {
  const session = {
    artifactId: agentSessionId,
    sessionStartedAt: startedAt,
    sessionEndedAt: null,
    artifact: { organizationId: ORG },
    tokenUsageByModel: [
      {
        model: MODEL,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0.01,
      },
    ],
    usageRollup: { runtimeMs: 1000 },
  };
  return Array.from({ length: branches }, (_unused, branch) => ({
    id: rowId(branch),
    agentSessionId,
    componentKey,
    invocationCount: 1,
    errorCount: 0,
    session,
  }));
}

type OrderByTerm =
  | { session: { sessionStartedAt: "asc" | "desc" } }
  | { agentSessionId: "asc" | "desc" }
  | { id: "asc" | "desc" };

export type FindManyArgs = {
  where?: Record<string, unknown>;
  orderBy?: OrderByTerm[];
  take?: number;
};

/** ISS-9851: the boundary session's aggregate, grouped by `componentKey`. */
export type GroupByArgs = {
  by: ["componentKey"];
  where?: Record<string, unknown>;
  _sum: { invocationCount: true; errorCount: true };
};

/** ISS-9851: the past-the-boundary existence probe. */
export type FindFirstArgs = {
  where?: Record<string, unknown>;
  select: { id: true };
};

/** Every query the store served, in order, tagged by the method that asked. */
export type StoreCall =
  | { method: "findMany"; args: FindManyArgs }
  | { method: "groupBy"; args: GroupByArgs }
  | { method: "findFirst"; args: FindFirstArgs };

/** The value one `orderBy` term reads off a row, as a comparable string. */
function orderKeyOf(row: UsageRowFixture, term: OrderByTerm): string {
  if ("session" in term) {
    return String(row.session.sessionStartedAt.getTime()).padStart(20, "0");
  }
  if ("agentSessionId" in term) {
    return row.agentSessionId;
  }
  return row.id;
}

/**
 * Byte order, not locale order: Postgres compares uuid and text this way, and
 * the keyset `gt` in the same query has to agree with the sort that produced
 * the cursor.
 */
function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/** The direction one `orderBy` term declares. */
function orderDirOf(term: OrderByTerm): number {
  const dir =
    "session" in term ? term.session.sessionStartedAt : Object.values(term)[0];
  return dir === "desc" ? -1 : 1;
}

type Comparison = { lt?: Date; gt?: string; gte?: Date; lte?: Date };

function matchesDate(value: Date, expected: Date | Comparison): boolean {
  if (expected instanceof Date) {
    return value.getTime() === expected.getTime();
  }
  if (expected.lt !== undefined && !(value.getTime() < expected.lt.getTime())) {
    return false;
  }
  if (
    expected.gte !== undefined &&
    !(value.getTime() >= expected.gte.getTime())
  ) {
    return false;
  }
  if (
    expected.lte !== undefined &&
    !(value.getTime() <= expected.lte.getTime())
  ) {
    return false;
  }
  return true;
}

function matchesSession(row: UsageRowFixture, clause: unknown): boolean {
  if (typeof clause !== "object" || clause === null) {
    return true;
  }
  const startedAt = (clause as { sessionStartedAt?: Date | Comparison })
    .sessionStartedAt;
  if (startedAt === undefined) {
    return true;
  }
  return matchesDate(row.session.sessionStartedAt, startedAt);
}

/**
 * The subset of the read's `where` this store executes: `AND`, `OR`,
 * `agentSessionId` (equality and the keyset `gt`), and the session's
 * `sessionStartedAt` bounds. Identity and org predicates are left to the
 * fixture, exactly as the pre-ISS-9851 double did.
 */
export function matchesWhere(
  row: UsageRowFixture,
  where: Record<string, unknown> | undefined
): boolean {
  if (!where) {
    return true;
  }
  for (const [key, clause] of Object.entries(where)) {
    if (key === "AND" && Array.isArray(clause)) {
      const all = clause.every((part) =>
        matchesWhere(row, part as Record<string, unknown>)
      );
      if (!all) {
        return false;
      }
    }
    if (key === "OR" && Array.isArray(clause)) {
      const any = clause.some((part) =>
        matchesWhere(row, part as Record<string, unknown>)
      );
      if (!any) {
        return false;
      }
    }
    if (key === "agentSessionId") {
      const gt = (clause as { gt?: string }).gt;
      if (typeof clause === "string" && row.agentSessionId !== clause) {
        return false;
      }
      if (gt !== undefined && !(row.agentSessionId > gt)) {
        return false;
      }
    }
    if (key === "session" && !matchesSession(row, clause)) {
      return false;
    }
  }
  return true;
}

/**
 * Install a `withDb` double over `rows`. Returns every query it served, in
 * order, so a test can assert what the boundary aggregate and the
 * past-the-boundary probe actually asked for.
 *
 * The sort is built FROM `args.orderBy` rather than hardcoded: a hardcoded
 * comparator would hand back correctly-ordered rows even if production dropped
 * the `agentSessionId` sort key, which would leave the contiguity half of
 * ISS-6887 with no test that can fail. The `groupBy` SUMS over the matched rows
 * for the same reason: an aggregate that echoed the probe's partial prefix
 * would leave the completion half with no test that can fail either.
 */
export function installRowStore(
  withDbMock: ReturnType<typeof vi.fn>,
  rows: UsageRowFixture[]
): { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const findMany = (args: FindManyArgs) => {
    calls.push({ method: "findMany", args });
    const scoped = rows.filter((row) => matchesWhere(row, args.where));
    const terms = args.orderBy ?? [];
    scoped.sort((a, b) => {
      for (const term of terms) {
        const compared = compareText(orderKeyOf(a, term), orderKeyOf(b, term));
        if (compared !== 0) {
          return compared * orderDirOf(term);
        }
      }
      return 0;
    });
    return Promise.resolve(
      args.take === undefined ? scoped : scoped.slice(0, args.take)
    );
  };
  const groupBy = (args: GroupByArgs) => {
    calls.push({ method: "groupBy", args });
    const sums = new Map<
      string,
      { invocationCount: number; errorCount: number }
    >();
    for (const row of rows) {
      if (!matchesWhere(row, args.where)) {
        continue;
      }
      const sum = sums.get(row.componentKey) ?? {
        invocationCount: 0,
        errorCount: 0,
      };
      sum.invocationCount += row.invocationCount;
      sum.errorCount += row.errorCount;
      sums.set(row.componentKey, sum);
    }
    return Promise.resolve(
      [...sums].map(([componentKey, sum]) => ({ componentKey, _sum: sum }))
    );
  };
  const findFirst = (args: FindFirstArgs) => {
    calls.push({ method: "findFirst", args });
    const found = rows.find((row) => matchesWhere(row, args.where));
    return Promise.resolve(found ? { id: found.id } : null);
  };
  withDbMock.mockImplementation(
    (
      cb: (db: {
        agentComponentSessionUsage: {
          findMany: typeof findMany;
          groupBy: typeof groupBy;
          findFirst: typeof findFirst;
        };
      }) => unknown
    ) => cb({ agentComponentSessionUsage: { findMany, groupBy, findFirst } })
  );
  return { calls };
}

/** How many usage rows each session contributes, from the fixture itself. */
export function rowsPerSession(
  rows: UsageRowFixture[]
): Map<string, { count: number; startedMs: number }> {
  const bySession = new Map<string, { count: number; startedMs: number }>();
  for (const row of rows) {
    const seen = bySession.get(row.agentSessionId);
    if (seen) {
      seen.count += 1;
    } else {
      bySession.set(row.agentSessionId, {
        count: 1,
        startedMs: row.session.sessionStartedAt.getTime(),
      });
    }
  }
  return bySession;
}

export type WalkPage = {
  points: Array<{ sessionId: string; componentInvocations: number }>;
  nextCursor?: string;
};

/**
 * Every way a keyset walk can be wrong, stated as findings rather than
 * assertions so a test can prove the checker BITES on a bad walk instead of
 * only that it passes on a good one.
 *
 * A session split across two pages shows up twice (`duplicate`); a session
 * summed from part of its rows shows up as `partial`; a session the walk never
 * reached shows up as `missing`.
 */
export function walkProblems(
  pages: WalkPage[],
  fixture: Map<string, { count: number; startedMs: number }>
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const page of pages) {
    for (const point of page.points) {
      const already = seen.get(point.sessionId);
      if (already === undefined) {
        seen.set(point.sessionId, point.componentInvocations);
      } else {
        problems.push(`duplicate ${point.sessionId}`);
      }
    }
  }
  for (const [sessionId, invocations] of seen) {
    const expected = fixture.get(sessionId)?.count;
    if (expected !== undefined && invocations !== expected) {
      problems.push(
        `partial ${sessionId}: ${invocations} of ${expected} rows counted`
      );
    }
  }
  for (const sessionId of fixture.keys()) {
    if (!seen.has(sessionId)) {
      problems.push(`missing ${sessionId}`);
    }
  }
  return problems;
}
