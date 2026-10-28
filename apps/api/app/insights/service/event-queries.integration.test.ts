import { InsightsScope } from "@repo/api/src/types/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  matching,
  type ObservedStatement,
  observeStatements,
} from "@/__tests__/support/db-statement-observer";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  countEvents,
  fetchEventTypeBuckets,
  fetchEventVolume,
  fetchToolUsageBuckets,
} from "@/app/insights/service/event-queries";
import type { InsightsScopeContext } from "@/app/insights/service/scope";

/**
 * ISS-7513 — the utilization section's `agent_session_events` reads are bounded
 * by the WINDOW, never by the population.
 *
 * These are the aggregations the section leans on hardest: profiling a
 * 112k-event corpus put `fetchEventVolume`, `countEvents` and
 * `fetchEventTypeBuckets` in the top four statements by wall time, ahead of
 * every other insights query.
 *
 * WHAT THIS SUITE PINS, EXACTLY: the date window, the org predicate, and the
 * fact that the RESPONSE SHAPE is a function of the window rather than of the
 * population. Each case runs at two corpus sizes so the last of those is
 * decidable — a single-size fixture cannot tell a series enumerated from the
 * window from one accumulated out of the returned rows, because at one size
 * both are "some points". The values still have to be right, so each case also
 * pins the aggregate against a count written out independently of the
 * arithmetic the fixture used.
 *
 * WHERE THE REDUCTION HAPPENED is a separate question from the value, and the
 * value cases cannot answer it: replacing the `count`/`groupBy` aggregates with
 * a `findMany` plus a JS reduce returns byte-identical results at every corpus
 * size. ISS-9627 adds the read-path budget that can — it observes the rows the
 * pg driver actually handed back, which is the one number the two shapes do not
 * share. Nothing here depends on the ISS-7513 index — that is a plan choice,
 * evidenced by EXPLAIN in the PR, not by a value.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T00:00:00.000Z");
/** Inclusive on both ends, so a 29-day span enumerates 30 daily points. */
const WINDOW_DAYS = 30;
const OUT_OF_WINDOW = new Date("2026-01-15T00:00:00.000Z");
const EVENT_TYPES = ["tool_use", "assistant_message", "user_message"];

/**
 * Seeded only on `tool_use` events, cycled so BOTH corpus sizes reach the same
 * distinct cardinality — which is what makes "bounded by the tool cardinality,
 * not the population" decidable across the two sizes. Every other event type
 * carries a NULL `toolName`, so the tool-bucket read has nulls to exclude.
 */
const TOOL_NAMES = ["Read", "Edit"];
/**
 * Which observed statements belong to a budget. Matches the physical table so a
 * `groupBy` and a `findMany` over the same rows are both claimed — a pattern
 * keyed on the aggregate would quietly stop matching the very regression these
 * budgets exist to catch.
 */
const EVENTS_TABLE_PATTERN = /agent_session_events/;
/** Compared against sorted bucket labels, so a value tie cannot flip an assertion. */
const SORTED_TOOL_NAMES = [...TOOL_NAMES].sort();

type Corpus = { sessions: number; eventsPerSession: number };

const SMALL: Corpus = { sessions: 3, eventsPerSession: 5 };
const LARGER: Corpus = { sessions: 6, eventsPerSession: 20 };

describeIfDb("insights event aggregations", () => {
  it("returns one point per window day at both corpus sizes", async () => {
    const small = await withCorpus(SMALL, (ctx) =>
      fetchEventVolume(ctx, WINDOW_START, WINDOW_END, "UTC")
    );
    const larger = await withCorpus(LARGER, (ctx) =>
      fetchEventVolume(ctx, WINDOW_START, WINDOW_END, "UTC")
    );

    // 4x the events and 2x the sessions, same number of points: the series is
    // enumerated from the window, not accumulated from the rows.
    expect(small.points).toHaveLength(WINDOW_DAYS);
    expect(larger.points).toHaveLength(WINDOW_DAYS);
    expect(small.series).toEqual([{ key: "events", label: "Events" }]);

    // Bounded is not the same as correct — a helper returning 30 zeroes would
    // satisfy every assertion above. The events are seeded one per day from the
    // window start, so day 0 carries exactly one event per session.
    expect(larger.points[0].values.events).toBe(LARGER.sessions);
    expect(small.points[0].values.events).toBe(SMALL.sessions);
  });

  it("counts every in-window event and no out-of-window event", async () => {
    const small = await withCorpus(SMALL, (ctx) =>
      countEvents(ctx, WINDOW_START, WINDOW_END)
    );
    const larger = await withCorpus(LARGER, (ctx) =>
      countEvents(ctx, WINDOW_START, WINDOW_END)
    );

    // Written as literals rather than as `sessions * eventsPerSession`: a count
    // re-derived with the same arithmetic the fixture used would agree with a
    // wrong query. Each corpus also seeds one event per session OUTSIDE the
    // window, so a lost date bound shows up as a surplus here.
    expect(small).toBe(15);
    expect(larger).toBe(120);
  });

  it("returns at most one bucket per event type however many events exist", async () => {
    const small = await withCorpus(SMALL, (ctx) =>
      fetchEventTypeBuckets(ctx, WINDOW_START, WINDOW_END)
    );
    const larger = await withCorpus(LARGER, (ctx) =>
      fetchEventTypeBuckets(ctx, WINDOW_START, WINDOW_END)
    );

    // The bucket count is bounded by the DISTINCT type cardinality — three —
    // not by the 120 events the larger corpus holds.
    expect(small).toHaveLength(EVENT_TYPES.length);
    expect(larger).toHaveLength(EVENT_TYPES.length);
    expect(larger.reduce((total, bucket) => total + bucket.value, 0)).toBe(120);
  });

  /**
   * #5818 review (whitlockk) — `fetchToolUsageBuckets` is the FOURTH
   * `agent_session_events` read named by the migration's own rationale, and it
   * was the one this suite left out. A regression that dropped `eventScope`
   * from only this query, or stopped excluding null `toolName`, was invisible
   * here.
   *
   * ONE HONEST LIMIT, stated so nobody reads more into a green run than it
   * proves: null exclusion is guarded TWICE — the `toolName: { not: null }`
   * predicate and the row `.filter()` after it — so removing either one alone
   * is unobservable in the returned value, at this tier or any other. What the
   * label assertion below does catch is losing BOTH, which is the case that
   * actually reaches a reader as a nameless "null" slice in the tool chart.
   */
  it("returns at most one bucket per tool however many events exist", async () => {
    const small = await withCorpus(SMALL, (ctx) =>
      fetchToolUsageBuckets(ctx, WINDOW_START, WINDOW_END)
    );
    const larger = await withCorpus(LARGER, (ctx) =>
      fetchToolUsageBuckets(ctx, WINDOW_START, WINDOW_END)
    );

    // Bounded by the DISTINCT tool cardinality — two — not by the 42 tool
    // events the larger corpus holds. A third bucket here is a null one.
    expect(small).toHaveLength(TOOL_NAMES.length);
    expect(larger).toHaveLength(TOOL_NAMES.length);
    expect(labelled(small)).toEqual(SORTED_TOOL_NAMES);
    expect(labelled(larger)).toEqual(SORTED_TOOL_NAMES);

    // Literals rather than `sessions * toolEventsPerSession`: a count
    // re-derived with the fixture's own arithmetic would agree with a wrong
    // query. Each corpus also seeds one NAMED tool event per session outside
    // the window, so a lost date bound reads as a surplus of 3 / 6 here.
    expect(countsByLabel(small)).toEqual({ Read: 3, Edit: 3 });
    expect(countsByLabel(larger)).toEqual({ Read: 24, Edit: 18 });
  });

  it("excludes another organization's tool events from the same window", async () => {
    // The org half of the same guard. Dropping `eventScope` from this one query
    // would still return exactly two buckets and still respect the window, so
    // the bound above cannot see it — only a second org in the same window can.
    const scoped = await autoRollbackTransaction(async () => {
      const ctx = await seedCorpus(SMALL);
      await seedCorpus(LARGER);
      return await fetchToolUsageBuckets(ctx, WINDOW_START, WINDOW_END);
    });

    expect(countsByLabel(scoped)).toEqual({ Read: 3, Edit: 3 });
  });

  /**
   * #8602 review (tamsinb): the session CTE is bounded by
   * `last_activity_at >= start`, so a 7-day read does not probe every session
   * the org ever had. Under the write invariant (`last_activity_at` is at least
   * the session's newest event) that bound changes no value, which makes it
   * invisible to every case above. This fixture breaks the invariant on
   * purpose: one session's activity anchor is moved before the window while its
   * in-window events stay, so only the prune predicate decides whether those
   * five events are counted. The seeded `lastActivityAt` equals WINDOW_START on
   * every other session, which also pins the bound as inclusive.
   */
  it("probes only sessions whose last activity reaches the window", async () => {
    const scoped = await autoRollbackTransaction(async () => {
      const ctx = await seedCorpus(SMALL);
      await withDb(async (db) => {
        const [stale] = await db.sessionDetail.findMany({
          where: { artifact: { organizationId: ctx.organizationId } },
          select: { artifactId: true },
          take: 1,
        });
        await db.sessionDetail.update({
          where: { artifactId: stale.artifactId },
          data: { lastActivityAt: OUT_OF_WINDOW },
          select: { artifactId: true },
        });
      });
      return await countEvents(ctx, WINDOW_START, WINDOW_END);
    });

    expect(scoped).toBe(10);
  });

  it("excludes another organization's events from the same window", async () => {
    // The positive sibling to every bound above: a bound that also dropped the
    // org predicate would still return 30 points and 3 buckets.
    const scoped = await autoRollbackTransaction(async () => {
      const ctx = await seedCorpus(SMALL);
      await seedCorpus(LARGER);
      return await countEvents(ctx, WINDOW_START, WINDOW_END);
    });

    expect(scoped).toBe(15);
  });
});

/**
 * ISS-9627 — the read-path budget for the utilization aggregates, counted in
 * ROWS THE DRIVER RETURNED rather than in wall time.
 *
 * The regression this catches is the one the value cases above cannot see: an
 * aggregate re-implemented as a `findMany` plus a JS reduce. It returns the
 * same answer, so nothing about the response moves — what moves is that the
 * whole matched population crosses the wire to produce it, which is precisely
 * the cost the retired terminal caps used to hide.
 *
 * So each budget is an EXACT row count, pinned at both corpus sizes. The
 * literals are written from the fixture's own shape (three seeded event types,
 * five and twenty distinct in-window days), never re-derived from the query, and
 * the population is asserted alongside so a budget that merely tracked the
 * population would be visible rather than plausible.
 */
describeIfDb("insights event read-path budgets (ISS-9627)", () => {
  it("returns one row per event TYPE, not one per event", async () => {
    const small = await withCorpus(SMALL, (ctx) =>
      observeStatements(() =>
        fetchEventTypeBuckets(ctx, WINDOW_START, WINDOW_END)
      )
    );
    const larger = await withCorpus(LARGER, (ctx) =>
      observeStatements(() =>
        fetchEventTypeBuckets(ctx, WINDOW_START, WINDOW_END)
      )
    );

    // One statement, and it hands back three rows — the seeded type
    // cardinality — while the population behind it goes 15 -> 120.
    expect(eventRowCounts(small.statements)).toEqual([3]);
    expect(eventRowCounts(larger.statements)).toEqual([3]);
    // The read still has to be right, or a query returning three empty rows
    // would satisfy the budget above.
    expect(sumOf(larger.result)).toBe(120);
    expect(sumOf(small.result)).toBe(15);
  });

  it("returns one row for a count, whatever the count is", async () => {
    const small = await withCorpus(SMALL, (ctx) =>
      observeStatements(() => countEvents(ctx, WINDOW_START, WINDOW_END))
    );
    const larger = await withCorpus(LARGER, (ctx) =>
      observeStatements(() => countEvents(ctx, WINDOW_START, WINDOW_END))
    );

    expect(eventRowCounts(small.statements)).toEqual([1]);
    expect(eventRowCounts(larger.statements)).toEqual([1]);
    expect(small.result).toBe(15);
    expect(larger.result).toBe(120);
  });

  it("returns one row per occupied DAY, not one per event", async () => {
    const small = await withCorpus(SMALL, (ctx) =>
      observeStatements(() =>
        fetchEventVolume(ctx, WINDOW_START, WINDOW_END, "UTC")
      )
    );
    const larger = await withCorpus(LARGER, (ctx) =>
      observeStatements(() =>
        fetchEventVolume(ctx, WINDOW_START, WINDOW_END, "UTC")
      )
    );

    // The fixture puts event `n` on day `n % 30`, so five and twenty distinct
    // days carry the 15 and 120 in-window events. Both are under the window's
    // own 30-day ceiling, and neither is the population.
    expect(eventRowCounts(small.statements)).toEqual([5]);
    expect(eventRowCounts(larger.statements)).toEqual([20]);
    // The series is still enumerated from the window, so a budget met by a
    // query that returned nothing would be visible here.
    expect(larger.result.points).toHaveLength(WINDOW_DAYS);
    expect(larger.result.points[0].values.events).toBe(LARGER.sessions);
  });
});

/**
 * Rows returned by each statement that read the events table, in issue order.
 * Scoped to that table so the transaction's own bookkeeping — and the seed's
 * statements, which run outside the observed window anyway — cannot enter a
 * budget.
 */
function eventRowCounts(statements: readonly ObservedStatement[]): number[] {
  return matching(statements, EVENTS_TABLE_PATTERN).map(
    (statement) => statement.rows
  );
}

function sumOf(buckets: readonly { value: number }[]): number {
  return buckets.reduce((total, bucket) => total + bucket.value, 0);
}

/**
 * The tool a seeded event names, or `null` for every non-`tool_use` event.
 * Cycled on the tool-event ordinal rather than on `n`, so both corpus sizes
 * cover every entry in {@link TOOL_NAMES}.
 */
function toolNameFor(n: number): string | null {
  if (n % EVENT_TYPES.length !== 0) {
    return null;
  }
  return TOOL_NAMES[Math.floor(n / EVENT_TYPES.length) % TOOL_NAMES.length];
}

/** Bucket labels, sorted, so a value tie cannot make an assertion order-dependent. */
function labelled(buckets: { label: string }[]): string[] {
  return buckets.map((bucket) => bucket.label).sort();
}

function countsByLabel(
  buckets: { label: string; value: number }[]
): Record<string, number> {
  return Object.fromEntries(
    buckets.map((bucket) => [bucket.label, bucket.value])
  );
}

/** Seed a corpus, run one read against it, and roll the whole thing back. */
function withCorpus<T>(
  corpus: Corpus,
  read: (ctx: InsightsScopeContext) => Promise<T>
): Promise<T> {
  return autoRollbackTransaction(async () => {
    const ctx = await seedCorpus(corpus);
    return await read(ctx);
  });
}

async function seedCorpus(corpus: Corpus): Promise<InsightsScopeContext> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);

  await withDb(async (db) => {
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: `events-perf-${organizationId}`,
        platform: "darwin",
      },
      select: { id: true },
    });

    for (let s = 0; s < corpus.sessions; s++) {
      const artifact = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.SESSION,
          name: `events-perf-session-${s}`,
          status: SESSION_STATUS.INACTIVE,
        },
        select: { id: true },
      });
      await db.sessionDetail.create({
        data: {
          artifactId: artifact.id,
          computeTargetId: computeTarget.id,
          externalSessionId: `events-perf-ext-${artifact.id}`,
          harness: "claude",
          sessionStartedAt: WINDOW_START,
          sessionUpdatedAt: WINDOW_START,
          lastActivityAt: WINDOW_START,
        },
        select: { artifactId: true },
      });
      await db.agentSessionEvent.createMany({
        data: [
          ...Array.from({ length: corpus.eventsPerSession }, (_unused, n) => ({
            agentSessionId: artifact.id,
            externalEventId: `${artifact.id}-${n}`,
            eventType: EVENT_TYPES[n % EVENT_TYPES.length],
            toolName: toolNameFor(n),
            // One per day from the window start, so the first daily bucket
            // holds exactly one event per session.
            eventCreatedAt: new Date(
              WINDOW_START.getTime() + (n % WINDOW_DAYS) * 86_400_000
            ),
          })),
          {
            agentSessionId: artifact.id,
            externalEventId: `${artifact.id}-outside`,
            eventType: EVENT_TYPES[0],
            // Named, so a tool-bucket read that lost its date bound shows up as
            // a surplus rather than as nothing at all.
            toolName: TOOL_NAMES[0],
            eventCreatedAt: OUT_OF_WINDOW,
          },
        ],
      });
    }
  });

  return { organizationId, userId: user.id, scope: InsightsScope.Org };
}
