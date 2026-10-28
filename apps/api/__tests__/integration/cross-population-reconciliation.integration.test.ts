/**
 * ISS-9624 (PRD-666): the Sessions populations must AGREE WITH EACH OTHER, not
 * merely each be complete on its own.
 *
 * The August 2026 audit found its disagreements by hand and nothing re-ran the
 * comparison afterwards, so each pair below is the executable form of one of
 * those hand comparisons.
 *
 * A reconciliation whose two sides come from one query, one fixture, or one
 * helper is arithmetic, not a test — it agrees with itself forever. So each pair
 * pins a production read against a SEPARATELY-issued query, plus a literal,
 * because agreement alone cannot catch a change that moves both sides together
 * (the doctrine `insights-headless-predicate-parity.test.ts` states).
 *
 * The PRD names four families. The other two are owned elsewhere: the
 * filter-facet pair against real Postgres by
 * `service/status-counts.integration.test.ts` (ISS-8858), and Local-vs-Cloud by
 * the sibling `local-cloud-session-reconciliation.integration.test.ts`. That
 * arm was unreachable from this tier until ISS-9686 (#6789) broke the import
 * edge that rooted the Engineer server-operations tree in this app's program.
 *
 * Seeds are COMMITTED and torn down by `createCommittedTestOrganizationTracker`,
 * not wrapped in `autoRollbackTransaction`: every read below reaches the database
 * through `withDb`, which hands back the POOLED client rather than joining an
 * ambient transaction, so rows living only inside an uncommitted fixture
 * transaction sit on another connection and are invisible to them.
 *
 * That also bounds what these pairs prove. None of the three reads is
 * transactional — for this input `findSessions` resolves to
 * `findDbPaginatedPage` (no cost filter, no display-value sort), and
 * `getUsageSummary` and `getAnalytics` call `withDb` directly — so every
 * statement takes its own READ COMMITTED snapshot, and the two sides of a pair
 * are not one observation of one population. Nothing writes to these
 * organizations while the file runs, so the comparisons hold; they hold because
 * the fixture is QUIESCENT, not because the reads share a snapshot, and they are
 * not evidence about concurrent writers. `RepeatableRead` is real but lives on
 * the paths this input does not take — `withSessionListSnapshot` in
 * `service/list-page-fetch.ts` (ISS-6892).
 */

import { ERROR_EVENT_PATTERN } from "@repo/api/src/agent-session-events";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "@/app/agent-sessions/service";
import type { SessionUsageInput } from "@/app/agent-sessions/service/records";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const committedOrganizations = createCommittedTestOrganizationTracker();

const SESSION_TIMESTAMP = new Date("2026-06-10T09:00:00.000Z");
/** Before {@link WINDOW_START} — the resumed session's start anchor only. */
const BEFORE_WINDOW = new Date("2026-05-01T09:00:00.000Z");
const WINDOW_START = "2026-06-01T00:00:00.000Z";

/**
 * Written from the seed table in {@link seedCorpus}, never read back off it — a
 * literal derived from the fixture data would move with a broken seed.
 */
const SEEDED_SESSION_COUNT = 5;
/**
 * Strictly fewer than {@link SEEDED_SESSION_COUNT}: `archived` sits before
 * {@link WINDOW_START} on BOTH anchors. Two distinct constants, because a
 * windowed read that equalled the unwindowed one could not tell "windowed on
 * `lastActivityAt`" from "never applied the window at all".
 */
const WINDOWED_SESSION_COUNT = 4;
/** The five below that carry a tool name; the sixth is deliberately null. */
const NAMED_TOOL_EVENT_COUNT = 5;
const SEEDED_EVENT_COUNT = 6;
/** Named once so the fixture and the classifier assertion cannot drift apart. */
const ERROR_SEED_EVENT_TYPE = "tool_error";
/**
 * Carried by the foreign organization's only event and by NO row under
 * {@link SeededCorpus.organizationId}, so a leak is unambiguous rather than an
 * arithmetic shift inside an existing tool's counts.
 */
const FOREIGN_TOOL_NAME = "Glob";
const FOREIGN_EVENT_COUNT = 1;

type SeededCorpus = { organizationId: string; foreignOrganizationId: string };

let corpus: SeededCorpus;

beforeAll(async () => {
  if (hasDatabase) {
    corpus = await seedCorpus();
  }
});

afterAll(() => committedOrganizations.cleanup());

describeIfDb("cross-population reconciliation (ISS-9624)", () => {
  it("reconciles the usage summary's total against the list's own total", async () => {
    // Sequential, not `Promise.all`: neither read is transactional (see the file
    // docstring), so overlapping them buys no consistency and only has the two
    // denominators fan their statements into the same small connection pool.
    const summary = await agentSessionsService.getUsageSummary(
      usageInput(corpus.organizationId)
    );
    const list = await agentSessionsService.findSessions(
      usageInput(corpus.organizationId)
    );

    expect(
      summary.totalSessions,
      "the summary cards and the table must describe one population"
    ).toBe(list.total);
    // Neither side alone: a regression that emptied BOTH would still agree.
    // This literal is also the org-scoping assertion for this pair — the foreign
    // organization {@link seedForeignOrg} seeds is in-window on both anchors, so
    // a read that lost `artifact.organizationId` counts it and overshoots.
    expect(list.total).toBe(SEEDED_SESSION_COUNT);

    // The same pair under a DATE WINDOW, which is the only shape that pins WHICH
    // anchor each side windows on. `resumed` started before this window and was
    // active inside it, so a summary windowing on `sessionStartedAt` — the
    // ISS-4429 regression — drops a row the table still paints, while an undated
    // read cannot tell the two anchors apart.
    const windowedSummary = await agentSessionsService.getUsageSummary(
      usageInput(corpus.organizationId, WINDOW_START)
    );
    const windowedList = await agentSessionsService.findSessions(
      usageInput(corpus.organizationId, WINDOW_START)
    );

    expect(
      windowedSummary.totalSessions,
      "summary and list must window on the same date anchor"
    ).toBe(windowedList.total);
    // Strictly fewer than the unwindowed read, so a window that was silently
    // never applied cannot satisfy this by returning the whole population.
    expect(windowedList.total).toBe(WINDOWED_SESSION_COUNT);
    expect(WINDOWED_SESSION_COUNT).toBeLessThan(SEEDED_SESSION_COUNT);
  });

  it("reconciles the analytics Tool rollup against the event rows it folds", async () => {
    const analytics = await agentSessionsService.getAnalytics(
      usageInput(corpus.organizationId)
    );
    const foldedInvocations = analytics.byTool.reduce(
      (running, tool) => running + tool.invocationCount,
      0
    );
    const { namedToolRows, allRows, sessionsPerTool } = await countEventRows(
      corpus.organizationId
    );

    // The rollup is folded in JS off the `events` relation; this count is a
    // direct SQL statement over the same table. ISS-6912 is exactly the case
    // where the fold silently emptied while the rows were all still there.
    expect(foldedInvocations).toBe(namedToolRows);
    for (const tool of analytics.byTool) {
      expect(
        tool.sessionCount,
        `distinct sessions invoking ${tool.toolName}`
      ).toBe(sessionsPerTool.get(tool.toolName));
    }
    // The tool-less event must be outside BOTH sides, so a regression that
    // counted every event on both could not agree here.
    expect(allRows).toBeGreaterThan(namedToolRows);
    expect(allRows).toBe(SEEDED_EVENT_COUNT);
    expect(namedToolRows).toBe(NAMED_TOOL_EVENT_COUNT);

    // Literals, because agreement alone cannot catch a change that moves the
    // fold and the count together. `errorCount` is pinned ONLY here: it is
    // classified in JS by `ERROR_EVENT_PATTERN`, so a SQL mirror built from the
    // same `ERROR_EVENT_TERMS` would drift with it rather than police it.
    //
    // Order is `invocationCount` desc (`aggregateByTool`), which is why the two
    // tools must keep DIFFERENT invocation counts — equal counts would fall back
    // to map-insertion order and make this array order incidental.
    expect(analytics.byTool).toEqual([
      { toolName: "Bash", invocationCount: 3, errorCount: 0, sessionCount: 2 },
      { toolName: "Read", invocationCount: 2, errorCount: 1, sessionCount: 1 },
    ]);
    // Reads the SAME constant the fixture seeds, so renaming the seeded event
    // type cannot leave this asserting a string no row carries — which is what
    // would make every `errorCount: 0` above trivially satisfied.
    expect(ERROR_EVENT_PATTERN.test(ERROR_SEED_EVENT_TYPE)).toBe(true);

    // ORG SCOPING. `countEventRows` is scoped BY HAND, so the SQL side of this
    // pair can never see another organization — which means every agreement
    // above is evidence about the production fold's org filter only if there was
    // something outside the org for it to have picked up. Assert the control row
    // EXISTS before asserting its absence: a foreign seed that silently failed
    // would satisfy the exclusion below while proving nothing.
    await expect(
      countEventRowsFor(corpus.foreignOrganizationId),
      "the foreign-org control must exist for its exclusion to mean anything"
    ).resolves.toBe(FOREIGN_EVENT_COUNT);
    expect(
      analytics.byTool.map((tool) => tool.toolName),
      "a fold that lost `artifact.organizationId` folds the foreign event in"
    ).not.toContain(FOREIGN_TOOL_NAME);
  });
});

function usageInput(
  organizationId: string,
  startDate?: string
): SessionUsageInput {
  // `quality: "all"` on every read: the list hides idle rows by default while
  // the summary does not, and that difference is a real one this pair is not
  // about.
  return { organizationId, filters: { quality: "all", startDate } };
}

/**
 * The event-row population, counted in SQL rather than folded — the independent
 * side of the analytics pair.
 *
 * The scope is hand-written rather than derived from the production `where`, and
 * that independence is the point: deriving it would make both sides one
 * predicate. It holds only while the caller's filters stay org-wide, as
 * {@link usageInput} keeps them. A future filter added to the analytics read
 * must be mirrored here, or this count silently ranges wider than the fold.
 */
async function countEventRows(organizationId: string) {
  return await withDb(async (db) => {
    const scope = { session: { artifact: { organizationId } } };
    const [namedToolRows, allRows, rowsWithTools] = await Promise.all([
      db.agentSessionEvent.count({
        where: { ...scope, toolName: { not: null } },
      }),
      db.agentSessionEvent.count({ where: scope }),
      db.agentSessionEvent.findMany({
        where: { ...scope, toolName: { not: null } },
        distinct: ["toolName", "agentSessionId"],
        select: { toolName: true },
      }),
    ]);
    const sessionsPerTool = new Map<string, number>();
    for (const row of rowsWithTools) {
      if (row.toolName) {
        sessionsPerTool.set(
          row.toolName,
          (sessionsPerTool.get(row.toolName) ?? 0) + 1
        );
      }
    }
    return { allRows, namedToolRows, sessionsPerTool };
  });
}

/**
 * Five sessions and six events in the TARGET organization, with no two
 * populations sharing a count so that no assertion above can be satisfied by a
 * coincidence — Bash is invoked three times across two sessions, Read twice
 * within one. {@link seedForeignOrg} adds a sixth session and a seventh event
 * under a second organization, which no count here includes.
 *
 * | session | events                                     |
 * |---------|--------------------------------------------|
 * | one      | Bash, Bash, Read(error), Read             |
 * | two      | Bash                                      |
 * | three    | one event carrying NO tool name           |
 * | resumed  | —                                         |
 * | archived | —                                         |
 *
 * The last two rows carry the window's two arms. `resumed` is the only row whose
 * anchors DIFFER — started before {@link WINDOW_START}, last active inside it —
 * which is what pins which anchor each side reads. `archived` sits before the
 * window on BOTH anchors, so it is the row a correctly-applied window EXCLUDES;
 * without it the windowed and unwindowed populations would be the same rows and
 * a window that was never applied would read as correct.
 */
async function seedCorpus(): Promise<SeededCorpus> {
  const organizationId = await committedOrganizations.create();
  const user = await createTestUser(organizationId);
  const seed = async (
    label: string,
    startedAt: Date = SESSION_TIMESTAMP,
    lastActivityAt: Date = SESSION_TIMESTAMP
  ) =>
    await createTestSessionDetail({
      organizationId,
      userId: user.id,
      label,
      sessionTimestamp: startedAt,
      lastActivityAt,
    });

  const alphaOne = await seed("one");
  const alphaTwo = await seed("two");
  const alphaThree = await seed("three");
  await seed("resumed", BEFORE_WINDOW);
  await seed("archived", BEFORE_WINDOW, BEFORE_WINDOW);

  await withDb((db) =>
    db.agentSessionEvent.createMany({
      data: [
        event(alphaOne, "e1", "tool_use", "Bash"),
        event(alphaOne, "e2", "tool_use", "Bash"),
        event(alphaOne, "e3", ERROR_SEED_EVENT_TYPE, "Read"),
        event(alphaOne, "e4", "tool_use", "Read"),
        event(alphaTwo, "e5", "tool_use", "Bash"),
        // The tool-less row every side must drop.
        event(alphaThree, "e6", "session_start", null),
      ],
    })
  );

  return { organizationId, foreignOrganizationId: await seedForeignOrg() };
}

/**
 * The org-scoping control: a SECOND committed organization carrying one
 * in-window session and one tool event.
 *
 * Without it the analytics pair cannot fail on a lost org filter.
 * {@link countEventRows} states its scope by hand, so the SQL side stays narrow
 * no matter what the service does — and with a single organization in the
 * fixture there is nothing wider for the production fold to have picked up, so
 * `foldedInvocations === namedToolRows` and the `byTool` literal are both
 * satisfied by a `getAnalytics` that dropped `artifact.organizationId`
 * entirely. The row is in-window on BOTH date anchors so it is equally visible
 * to the windowed and unwindowed reads.
 */
async function seedForeignOrg(): Promise<string> {
  const organizationId = await committedOrganizations.create();
  const user = await createTestUser(organizationId);
  const session = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: "foreign",
    sessionTimestamp: SESSION_TIMESTAMP,
    lastActivityAt: SESSION_TIMESTAMP,
  });

  await withDb((db) =>
    db.agentSessionEvent.createMany({
      data: [event(session, "f1", "tool_use", FOREIGN_TOOL_NAME)],
    })
  );

  return organizationId;
}

/** Existence check for the {@link seedForeignOrg} control. */
async function countEventRowsFor(organizationId: string): Promise<number> {
  return await withDb((db) =>
    db.agentSessionEvent.count({
      where: { session: { artifact: { organizationId } } },
    })
  );
}

function event(
  agentSessionId: string,
  externalEventId: string,
  eventType: string,
  toolName: string | null
) {
  return {
    agentSessionId,
    externalEventId,
    eventType,
    toolName,
    eventCreatedAt: SESSION_TIMESTAMP,
  };
}
