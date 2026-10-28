/**
 * ISS-11312 — the committed half of the session-sync coverage.
 *
 * `upsertSessionsBatch` opens ONE `withDb.tx` per session inside its slice loop,
 * with a declared `timeout`/`maxWait`, and hands that one transaction to every
 * phase of the slice. The twenty-one suites that declare
 * `joinAmbientTransactionForSessionSyncWrites` run inside
 * `autoRollbackTransaction`, whose single ambient transaction absorbs each nested
 * one — so they pin what the batch WRITES and none of them can fail if the
 * per-session boundary is deleted. ISS-11104 made that blindness loud; this file
 * is the fixture that makes the boundary itself observable, so the opt-out guards
 * a property that is actually pinned somewhere. It does not RETIRE that opt-out:
 * whether any of the 21 can drop it was measured, and none can — the numbers and
 * the re-measure condition are in that helper's docstring, stated once.
 *
 * COMMITTED DRIVERS OF THIS BATCH DO ALREADY EXIST and are not part of that 21:
 * several suites reach the batch on `createCommittedTestOrganizationTracker`
 * instead of the ambient-rollback joiner — eight of them when this was written,
 * and deliberately NOT enumerated here, because a hand-kept list of them goes
 * stale the day the ninth lands. The predicate IS the set: a suite that reaches
 * the session-sync batch while running on a committed tracker rather than
 * declaring `joinAmbientTransactionForSessionSyncWrites`. None of them
 * ASSERTS the boundary — they assert rows that happen to need committing —
 * which is why this file exists rather than an assertion added to one of them.
 *
 * It therefore cannot use `autoRollbackTransaction` and deliberately does not:
 * that wrapper collapses every slice into one `BEGIN … ROLLBACK` and pins the
 * distinct-writer count at 1 however the service is written. It runs on
 * `createCommittedTestOrganizationTracker` and cleans up after itself.
 *
 * `xmin` is the transaction that last wrote a row, which is a sound oracle here
 * only because no phase of the slice opens a nested transaction or a SAVEPOINT —
 * a savepoint-based retry inside one committed slice would give its writes
 * different subtransaction xids and red the equality cases below for a reason
 * that is not the boundary. That is the invariant to re-check before adding one.
 */
import { Harness } from "@repo/api/src/types/agent-component";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
  type SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { upsertSessionsBatch } from "./upsert-sessions-batch";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * Pinned to LITERALS on purpose. `upsertSessionsBatch` has no chunk-size constant
 * to derive the session count from — its chunk IS the session — so the only thing
 * that could make the boundary assertions unfalsifiable is a payload carrying ONE
 * session, under which "each slice committed separately" and "all slices
 * committed together" are the same observation. The second case below is what
 * refuses that.
 */
const SESSION_COUNT = 4;
const EVENTS_PER_SESSION = 2;

const STARTED_AT = "2026-09-20T10:00:00.000Z";
const UPDATED_AT = "2026-09-20T11:00:00.000Z";

describeIfDb(
  "upsertSessionsBatch — committed per-session commit boundary",
  () => {
    const tracker = createCommittedTestOrganizationTracker();
    let organizationId = "";

    beforeAll(async () => {
      organizationId = await tracker.create();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id,
        "iss11312-boundary-machine"
      );
      await upsertSessionsBatch(
        { organizationId, userId: user.id, computeTargetId },
        buildPayload(SESSION_COUNT)
      );
      // No per-hook budget: the integration tier owns that number
      // (`hookTimeout` in `vitest.config.integration.mts`), and
      // `__tests__/integration-suite-timeout-budget.test.ts` reds on any suite
      // declaring a longer one — a suite that may outlast the job cannot report
      // a failure, it can only reap the job. This seeding hook runs in ~1.2s.
    });

    afterAll(async () => {
      await tracker.cleanup();
    });

    it("ingests every session in the batch, and every event of each", async () => {
      // The precondition the boundary cases rest on, asserted separately so a
      // seeding or deferral regression reds HERE, naming itself, instead of
      // reading as a boundary collapse. It is also what keeps the runtime budget
      // out of this fixture's determinism: the payload omits
      // `wantsAcceptedSessionIds`, so `resolveSliceBudget` never reads the clock
      // and no slice can be deferred — and if a future edit opts this payload
      // into row-level ack, a deferred tail shows up as a short count right
      // here rather than as a quietly narrower boundary observation.
      const rows = await withDb(
        (db) =>
          db.$queryRaw<{ sessions: bigint; events: bigint }[]>`
        SELECT count(DISTINCT d.artifact_id) AS sessions,
               count(e.id) AS events
        FROM session_detail d
        JOIN artifacts a ON a.id = d.artifact_id
        LEFT JOIN agent_session_events e ON e.agent_session_id = d.artifact_id
        WHERE a.organization_id = ${organizationId}::uuid
      `
      );

      expect(Number(rows[0]?.sessions)).toBe(SESSION_COUNT);
      expect(Number(rows[0]?.events)).toBe(SESSION_COUNT * EVENTS_PER_SESSION);
    });

    it("carries more than one session, so more than one boundary is observable", () => {
      // A single-session payload satisfies every case below while observing
      // nothing — one slice cannot disagree with itself about which transaction
      // wrote it. This is the falsifiability guard, not a tautology about the
      // literal: it is what fails if SESSION_COUNT is ever narrowed to 1.
      expect(SESSION_COUNT).toBeGreaterThan(1);
    });

    it("gives each session's slice its own writing transaction id, not one shared one", async () => {
      // Hoisting the slice loop's `withDb.tx` out of the loop puts every
      // session's artifact on ONE transaction, so this count collapses from
      // SESSION_COUNT to 1.
      //
      // DISTINCT WRITER IDS IS ALL THIS CASE CLAIMS, and it is deliberately not
      // the whole boundary: a pooled non-transactional write gives each
      // statement its own implicit xid and satisfies this identically
      // (measured). The two atomicity cases below are what make the pair a
      // claim about a transaction rather than about four ids.
      const writers = await withDb(
        (db) =>
          db.$queryRaw<{ xmin: string }[]>`
        SELECT DISTINCT a.xmin::text AS xmin
        FROM artifacts a
        JOIN session_detail d ON d.artifact_id = a.id
        WHERE a.organization_id = ${organizationId}::uuid
      `
      );

      expect(writers).toHaveLength(SESSION_COUNT);
    });

    it("commits a session's artifact and its detail row in the same transaction", async () => {
      // What the count above does NOT survive: replacing the slice's
      // `withDb.tx` with a plain pooled `withDb` lands the artifact row and the
      // `session_detail` row of one session in DIFFERENT transactions, which is
      // the slice atomicity the per-session boundary exists to provide.
      //
      // Both halves, because `mismatches` alone is 0 over zero joined rows: if
      // the detail write disappeared entirely, a case named for slice atomicity
      // would stay green over an ingest that stored no session. `paired` is the
      // presence assertion on the same join `mismatches` is the absence
      // assertion on.
      const rows = await withDb(
        (db) =>
          db.$queryRaw<{ paired: bigint; mismatches: bigint }[]>`
        SELECT count(*) AS paired,
               count(*) FILTER (WHERE a.xmin <> d.xmin) AS mismatches
        FROM artifacts a
        JOIN session_detail d ON d.artifact_id = a.id
        WHERE a.organization_id = ${organizationId}::uuid
      `
      );

      expect(Number(rows[0]?.paired)).toBe(SESSION_COUNT);
      expect(Number(rows[0]?.mismatches)).toBe(0);
    });

    it("commits a session's child event rows in that same transaction", async () => {
      // `upsertSessionSlice` hands the SAME `tx` to its identity, detail, child
      // and link phases, so the boundary's promise covers more than the detail
      // row. This join is the child half of it: a change that leaves the
      // detail write inside the slice transaction and takes the child writes
      // out of it reds HERE and nowhere else — the case above joins
      // `artifacts` to `session_detail` and cannot see it, and with an
      // events-free payload every child write is a no-op so no assertion
      // anywhere could. Hence the two events per session and this third join.
      //
      // WHAT THAT MUTATION IS NOT, measured 2026-09-28: it is not swapping
      // `persistSessionSliceChildren`'s `tx` for `withDb`. `withDb` reads the
      // ambient transaction out of AsyncLocalStorage and JOINS it when one is
      // open (`packages/database/index.ts`, `const tx = als.getStore()?.tx`),
      // so inside the slice that swap is a no-op and all five cases here stay
      // green — it does not demonstrate this case, and it does not refute it
      // either. Removing the slice loop's boundary itself (`withDb.tx` ->
      // `withDb` in `upsert-sessions-batch.ts`, where nothing is ambient yet)
      // reds this case at `expected 8 to be +0` alongside the detail case.
      const rows = await withDb(
        (db) =>
          db.$queryRaw<{ paired: bigint; mismatches: bigint }[]>`
        SELECT count(*) AS paired,
               count(*) FILTER (WHERE a.xmin <> e.xmin) AS mismatches
        FROM artifacts a
        JOIN agent_session_events e ON e.agent_session_id = a.id
        WHERE a.organization_id = ${organizationId}::uuid
      `
      );

      expect(Number(rows[0]?.paired)).toBe(SESSION_COUNT * EVENTS_PER_SESSION);
      expect(Number(rows[0]?.mismatches)).toBe(0);
    });
  }
);

function buildEvent(
  sessionIndex: number,
  eventIndex: number
): SyncedAgentSessionEvent {
  return {
    externalEventId: `iss11312-boundary-event-${sessionIndex}-${eventIndex}`,
    eventType: "assistant",
    createdAt: STARTED_AT,
  };
}

function buildSession(index: number): SyncedAgentSession {
  return {
    externalSessionId: `iss11312-boundary-session-${index}`,
    name: `ISS-11312 boundary session ${index}`,
    status: SESSION_STATUS.ACTIVE,
    harness: Harness.Claude,
    cwd: "/tmp/iss11312-boundary",
    startedAt: STARTED_AT,
    updatedAt: UPDATED_AT,
    agents: [],
    events: Array.from({ length: EVENTS_PER_SESSION }, (_, eventIndex) =>
      buildEvent(index, eventIndex)
    ),
    tokenUsageByModel: [],
  };
}

/**
 * `wantsAcceptedSessionIds` is deliberately ABSENT: it is what puts
 * `upsertSessionsBatch` on the legacy all-or-nothing arm, where
 * `resolveSliceBudget` returns the unclamped transaction timeout without reading
 * the clock, so no slice of this payload can be deferred by
 * `SessionIngestWorkBudget.RuntimeMs` on a loaded host. A multi-session batch IS
 * the legacy shape — today's desktop sends one session per request — so this is
 * the realistic payload for the boundary, not a convenience.
 */
function buildPayload(sessionCount: number): DesktopAgentSessionsPayload {
  const sessions = Array.from({ length: sessionCount }, (_, index) =>
    buildSession(index)
  );
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "0b6a1d3e-4c5f-4a2b-9d8e-1f2a3b4c5d6e",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}
