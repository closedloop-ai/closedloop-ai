/**
 * @file invocation-sync-abandoned-part.test.ts
 * @description ISS-5855 — an invocation-delivery part whose PARENT session never
 * reached the cloud inside the retry horizon is age-budgeted into abandonment,
 * and until this check that loss produced no signal a human would notice.
 *
 * ISS-5789 made `session_missing` a bounded permanent rejection, which is correct
 * and which is exactly what made the terminal state reachable on a schedule. This
 * in-place recovery deliberately excludes this age-budgeted path, so a part
 * parked there stays incomplete upstream until a later materialization path
 * supersedes it. ISS-5347 already made the abandonment name itself in the
 * main-process log; a log is not an alert.
 *
 * These cases pin the two halves that turn it into one:
 *
 *  1. the lane records its OWN terminal cause on the row, not the cloud's ack
 *     reason — without which the loss is not selectable at all, because every row
 *     still healthily deferring inside its horizon also carries `session_missing`;
 *  2. the store-integrity probe that owns the monitored `store.integrity.*` cadence
 *     sees that marker and raises a category distinct from ISS-6209's corruption.
 *
 * SCOPE. This suite proves the age-budgeted loss is VISIBLE. It deliberately
 * asserts nothing about the attempt-budgeted in-place recovery path.
 *
 * Every case that can be a behaviour against a real store is one. The negative
 * cases are load-bearing rather than decorative: an "it emitted a diagnostic" test
 * passes just as happily when the lane emits for a row that is still retrying, so
 * the within-horizon cases below are what separate "reports the loss" from
 * "reports everything".
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, test } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_OUTBOX_TABLE,
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AgentComponentInvocationSyncLocalError,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { AgentComponentInvocationSyncService } from "../src/main/agent-sync/agent-component-invocation-sync-service.js";
import { SESSION_MISSING_MAX_RETRY_AGE_MS } from "../src/main/agent-sync/invocation-sync-rejection-policy.js";
import { readInvocationSyncOutboxObservedThroughMs } from "../src/main/database/invocation-sync-integrity-observation.js";
import {
  INVOCATION_SYNC_OUTBOX_INTEGRITY_PAGE_SIZE,
  INVOCATION_SYNC_OUTBOX_INTEGRITY_SCHEMA,
  INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS,
  runInvocationSyncOutboxIntegrityCheck,
} from "../src/main/database/invocation-sync-outbox-integrity.js";
import type {
  DesktopPrisma,
  DesktopPrismaReadClient,
} from "../src/main/database/prisma-client.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  collectInvocationSyncOutboxIssues as collectIssues,
  type Db,
  deliveryRows,
  makeInvocationSyncDir,
  NOW,
  openDb,
  SKILL_CONTENT_V1,
  sessionMissingService,
  skillSession,
} from "./helpers/invocation-sync-fixtures.js";
import {
  FakeSource,
  part,
  SESSION_MISSING_HORIZON_INTACT_AT,
  SESSION_MISSING_HORIZON_SPENT_AT,
} from "./helpers/invocation-sync-service-fixtures.js";

/** The monitored issue category this ticket makes reachable. */
const ABANDONED_CATEGORY = "abandoned_invocation_sync_outbox_part";

/** ISS-6209's category, asserted here only to prove the two do not collapse. */
const CORRUPT_CATEGORY = "unreadable_invocation_sync_outbox_timestamp";

describe("ISS-5855 the lane names its own terminal cause when it abandons a part", () => {
  /**
   * The marker the whole change rests on. `last_error` previously recorded the ack
   * REASON, and `session_missing` is carried by every row still deferring inside
   * its horizon — so a dead-lettered row was indistinguishable from a retrying one
   * by anything but its status, and nothing could select the abandoned population
   * to report it.
   */
  test("an outlived part is dead-lettered with the abandonment cause, not the ack reason", async () => {
    const source = new FakeSource(part());
    await abandoningService(
      source,
      SESSION_MISSING_HORIZON_SPENT_AT
    ).syncOnce();

    assert.equal(
      source.deadLetterCalls,
      1,
      "a part that has outlived its horizon must be abandoned"
    );
    assert.equal(
      source.deadLetteredError,
      AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted,
      "the row must record why THIS LANE gave up, not what the cloud said on one attempt"
    );
    assert.notEqual(
      source.deadLetteredError,
      AgentComponentInvocationSyncRejectReason.SessionMissing,
      "the ack reason cannot distinguish an abandoned row from a deferring one"
    );
  });

  /**
   * The negative half: a row inside its horizon is never terminalized, so nothing
   * is ever recorded as abandoned for it.
   *
   * Stated precisely, because the obvious reading is wrong: this case pins the
   * BUDGET map, not the cause map. `Within` carries `permanent: false`,
   * `decideOutboxFailure` reaches its dead-letter branch only when `permanent` is
   * true, and `terminalCauseForRejection` is called only inside that branch — so
   * `Within` never reaches the cause map at all, and this case cannot fail for a
   * mutation to it. What it does catch is `Within` being priced as terminal, which
   * would abandon healthy parts wholesale during the ordinary ordering race. The
   * `horizon === undefined` half of the cause map is pinned by the sibling
   * `validation_failed` case below.
   */
  test("a part still inside its horizon is not abandoned and records no cause", async () => {
    const source = new FakeSource(part());
    await abandoningService(
      source,
      SESSION_MISSING_HORIZON_INTACT_AT
    ).syncOnce();

    assert.equal(
      source.deadLetterCalls,
      0,
      "a part inside its horizon is still deferring — the parent may yet arrive"
    );
    assert.equal(
      source.deadLetteredError,
      null,
      "nothing may be recorded as abandoned while the row is still retrying"
    );
    assert.equal(
      source.entries.length,
      1,
      "the part must remain queued for its next attempt"
    );
  });

  /**
   * The other way an unconditional marker hides: a reason whose ack IS the whole
   * story. `validation_failed` is attributed by the cloud to this row's own
   * content, so overwriting it with a lane-side abandonment cause would both lose
   * the real reason and inflate the ISS-5855 population with rows whose parent was
   * never the problem.
   */
  test("a content-rejected part still records the cloud's ack reason", async () => {
    // One short of the ordinary permanent ceiling, so this ack is the terminal one.
    const source = new FakeSource(part(), 4).withPermanentAttemptCount(4);
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: (pending) =>
        Promise.resolve(
          rejectionAck(
            pending,
            AgentComponentInvocationSyncRejectReason.ValidationFailed
          )
        ),
      now: () => new Date(SESSION_MISSING_HORIZON_SPENT_AT),
    });

    await service.syncOnce();

    assert.equal(source.deadLetterCalls, 1);
    assert.equal(
      source.deadLetteredError,
      AgentComponentInvocationSyncRejectReason.ValidationFailed,
      "a row the cloud refused on its own content is not an ISS-5855 abandonment"
    );
  });
});

describe("ISS-5855 the abandonment reaches the monitored store-integrity event", () => {
  /**
   * End to end, through the production service against a real store: the parent is
   * missing, the horizon is spent, the lane abandons the part, and the probe that
   * owns the monitored `store.integrity.*` cadence reports it.
   *
   * Driven by the real lane rather than by a hand-parked row for the same reason
   * ISS-6209's race case is: the sync loop ticks every 5s while the probe's first
   * run is 5 minutes out, so in production the probe never sees these rows as
   * `pending` — it only ever meets them already dead-lettered.
   */
  test("a part abandoned by the lane raises the abandoned-part issue", async () => {
    const dir = await makeInvocationSyncDir("aci-abandoned-");
    const db = await openDb(dir);
    const sessionId = "session-abandoned-parent";
    const computeTargetId = "target-abandoned";
    const target = buildAgentComponentInvocationSyncSourceKey(computeTargetId);
    try {
      await seedDeliveryRow(db, sessionId, target);
      await ageDeliveryRow(db, target, sessionId, horizonSpentCreatedAt());

      await sessionMissingService(db, computeTargetId).syncOnce();

      const parked = await deliveryRows(db, target, sessionId);
      assert.equal(
        parked[0]?.status,
        OutboxStatus.DeadLettered,
        "the lane must abandon a part whose parent never arrived in time"
      );
      assert.equal(
        parked[0]?.last_error,
        AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted,
        "the abandonment must be selectable by the probe that reports it"
      );

      // Probe at the LAST instant still inside the window, read off the row's own
      // parking stamp. `Date.parse(NOW)` would be wrong and silently so: the
      // service clock is injected but `deadLetterInvocationSyncPart` stamps
      // `updated_at` from the REAL wall clock, so probing at NOW gives a NEGATIVE
      // age that no window arithmetic can ever reject — the count would be
      // satisfied by an unreachable instant rather than by the row being recent,
      // and shrinking the window to 1ms would leave this green.
      const parkedAtMs = Date.parse(parked[0]?.updated_at ?? "");
      assert.ok(
        Number.isFinite(parkedAtMs),
        "the dead-letter write must stamp a readable updated_at"
      );
      const probe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        parkedAtMs + INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS - 1
      );
      assert.equal(
        probe.recentlyAbandonedPartRows,
        1,
        "the permanently-lost part must be counted for the whole report window"
      );
      assert.equal(
        probe.unreadableCreatedAtRows,
        0,
        "nothing is wrong with this store — the parent is what is missing"
      );
      assert.deepEqual(
        collectIssues(probe).map((issue) => issue.category),
        [ABANDONED_CATEGORY],
        "the loss must reach the already-monitored store-integrity event"
      );
      assert.equal(
        collectIssues(probe)[0]?.object,
        AGENT_COMPONENT_INVOCATION_SYNC_OUTBOX_TABLE,
        "the issue names the table only — the row stays in the main-process log"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The negative half against the real store, and the case that separates this
   * change from "alert on every session_missing". A part whose parent is merely
   * LATE is the ordinary and self-healing condition (the ordering race, cause 2 in
   * the rejection policy); alerting on it would fire the monitored event on
   * routine traffic and train exactly the wrong reflex about it.
   *
   * The fixture is identical to the case above but for the row's age, so the only
   * thing that can make this pass while that one also passes is the horizon
   * actually being consulted.
   */
  test("a part whose parent is merely late raises nothing", async () => {
    const dir = await makeInvocationSyncDir("aci-abandoned-within-");
    const db = await openDb(dir);
    const sessionId = "session-late-parent";
    const computeTargetId = "target-late";
    const target = buildAgentComponentInvocationSyncSourceKey(computeTargetId);
    try {
      await seedDeliveryRow(db, sessionId, target);
      await ageDeliveryRow(db, target, sessionId, horizonIntactCreatedAt());

      await sessionMissingService(db, computeTargetId).syncOnce();

      const deferred = await deliveryRows(db, target, sessionId);
      assert.equal(
        deferred[0]?.status,
        OutboxStatus.Pending,
        "a part inside its horizon must still be queued, not abandoned"
      );

      const probe = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        Date.parse(NOW)
      );
      assert.equal(
        probe.recentlyAbandonedPartRows,
        0,
        "a retrying part is not a loss and must not be reported as one"
      );
      assert.deepEqual(
        collectIssues(probe),
        [],
        "the monitored event must stay silent while the lane is still trying"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Nothing in this lane ever DELETES a dead-lettered row, so an unbounded rule
   * would pin the store permanently unhealthy on one incident — the same recovery
   * edge ISS-6209 established for its own population, which this one reuses rather
   * than re-deriving.
   *
   * The probe inside the window is REQUIRED, and was added when the window stopped
   * being sufficient on its own: it may now only age out a row the monitor has
   * already been told about (codex review, `invocation-sync-integrity-observation.ts`),
   * because measured from parking alone it expires across a shutdown before any probe
   * ran and discards the loss unreported. So the expectation this case pins is
   * narrower than it was — the recovery edge closes for an OBSERVED row — and the
   * behaviour it used to assert for an unobserved one now belongs to
   * `invocation-sync-unreported-abandonment.test.ts`, which asserts the opposite of
   * it deliberately.
   */
  test("past its report window a reported abandoned part stops raising the issue", async () => {
    const dir = await makeInvocationSyncDir("aci-abandoned-window-");
    const db = await openDb(dir);
    const sessionId = "session-abandoned-window";
    const computeTargetId = "target-window";
    const target = buildAgentComponentInvocationSyncSourceKey(computeTargetId);
    try {
      await seedDeliveryRow(db, sessionId, target);
      await ageDeliveryRow(db, target, sessionId, horizonSpentCreatedAt());
      await sessionMissingService(db, computeTargetId).syncOnce();

      const parked = await deliveryRows(db, target, sessionId);
      const parkedAtMs = Date.parse(parked[0]?.updated_at ?? "");
      assert.ok(
        Number.isFinite(parkedAtMs),
        "the dead-letter write must stamp a readable updated_at"
      );

      const reported = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        parkedAtMs + 1
      );
      assert.equal(
        reported.recentlyAbandonedPartRows,
        1,
        "the loss must reach the monitor before the window may retire it"
      );

      const afterWindow = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        parkedAtMs + INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS
      );
      assert.equal(afterWindow.recentlyAbandonedPartRows, 0);
      assert.deepEqual(collectIssues(afterWindow), []);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The `dead_lettered` half of the scan's `OR` is production surface THIS change
   * added — before it, the only parked rows the scan could match were ISS-6209's,
   * and the existing paging case in `invocation-sync-corrupt-created-at.test.ts`
   * seeds `status: pending` rows exclusively. So every cursor continuation over a
   * parked row was unexercised, in both populations.
   *
   * That is the wrong path to leave untested here for the same reason ISS-6209
   * gave for testing its own: a backlog deep enough to page is precisely what a
   * cloud outage produces, and a cloud outage is when parents go missing. The
   * three populations are INTERLEAVED so the page boundary at row 200 falls
   * mid-pattern — a cursor that advances correctly for a homogeneous page can
   * still lose or double-count when the statuses alternate across it.
   */
  test("the widened scan pages over parked rows without losing or double-counting", async () => {
    const dir = await makeInvocationSyncDir("aci-abandoned-page-");
    const db = await openDb(dir);
    const target = buildAgentComponentInvocationSyncSourceKey("target-page");
    // One full page plus a remainder, so the cursor is followed at least twice.
    const totalRows = INVOCATION_SYNC_OUTBOX_INTEGRITY_PAGE_SIZE + 7;
    const perPopulation = totalRows / 3;
    try {
      await db.prisma.write((client) =>
        client.agentComponentInvocationSyncOutbox.createMany({
          data: Array.from({ length: totalRows }, (_, index) => ({
            sourceKey: target,
            externalSessionId: `session-page-${`${index}`.padStart(4, "0")}`,
            externalGenerationId: "g".repeat(64),
            partIndex: 0,
            partCount: 1,
            partHash: "h".repeat(64),
            sourceUpdatedAt: NOW,
            dataRevision: 1,
            sourceSequence: 0,
            payload: "{}",
            ...pagedRowState(index),
            updatedAt: NOW,
          })),
        })
      );

      const scanned = await runInvocationSyncOutboxIntegrityCheck(
        db.prisma,
        Date.parse(NOW)
      );

      assert.equal(
        scanned.recentlyAbandonedPartRows,
        perPopulation,
        "every abandoned row across every page must be counted exactly once"
      );
      assert.equal(
        scanned.recentlyQuarantinedCorruptRows,
        perPopulation,
        "the ISS-6209 parked population must page correctly alongside it"
      );
      assert.equal(
        scanned.unreadableCreatedAtRows,
        perPopulation,
        "the pending population must not be disturbed by the widened match"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Two findings about one table, and an operator acts on them differently: a
   * corrupt timestamp says inspect the STORE, an abandoned part says the store is
   * fine and the DATA IS GONE. Folding ISS-5855 into ISS-6209's category would let
   * a corruption alert mask a data-loss alert and vice versa, and would read as
   * green here if the classifier only ever emitted one issue.
   */
  test("corruption and abandonment raise distinct categories, not one merged issue", () => {
    const issues = collectIssues({
      unreadableCreatedAtRows: 0,
      recentlyQuarantinedCorruptRows: 2,
      recentlyAbandonedPartRows: 3,
    });

    assert.deepEqual(issues.map((issue) => issue.category).toSorted(), [
      ABANDONED_CATEGORY,
      CORRUPT_CATEGORY,
    ]);
  });

  /**
   * The db-host boundary is a real process boundary and its schema STRIPS unknown
   * keys, so a desktop build newer than its db-host must degrade to "none seen"
   * rather than fail the read or invent a count. Both shapes are covered because
   * only the pair distinguishes "absent degrades safely" from "the field is never
   * read at all".
   */
  test("a db-host answering without the new count degrades to no issue", () => {
    const older = INVOCATION_SYNC_OUTBOX_INTEGRITY_SCHEMA.parse({
      unreadableCreatedAtRows: 0,
    });
    assert.equal(older.recentlyAbandonedPartRows, undefined);
    assert.deepEqual(collectIssues(older), []);

    const current = INVOCATION_SYNC_OUTBOX_INTEGRITY_SCHEMA.parse({
      unreadableCreatedAtRows: 0,
      recentlyAbandonedPartRows: 1,
    });
    assert.deepEqual(
      collectIssues(current).map((issue) => issue.category),
      [ABANDONED_CATEGORY],
      "a host that DOES report the count must still raise the issue"
    );
  });

  test("ISS-7980: a rejected observation write rejects the check without advancing its marker", async () => {
    const dir = await makeInvocationSyncDir("aci-observation-reject-");
    const db = await openDb(dir);
    const writeError = new Error("observation write rejected");
    let writeCalls = 0;
    const rejectingObservationPrisma = {
      read: <T>(
        run: (client: DesktopPrismaReadClient) => Promise<T>
      ): Promise<T> => db.prisma.read(run),
      write: (): Promise<never> => {
        writeCalls += 1;
        return Promise.reject(writeError);
      },
    } as unknown as DesktopPrisma;
    try {
      await assert.rejects(
        () =>
          runInvocationSyncOutboxIntegrityCheck(
            rejectingObservationPrisma,
            Date.parse(NOW)
          ),
        (error: unknown) => error === writeError
      );

      assert.equal(
        writeCalls,
        1,
        "the completed scan must attempt its durable observation write"
      );
      assert.equal(
        await db.prisma.read((reader) =>
          readInvocationSyncOutboxObservedThroughMs(reader)
        ),
        undefined,
        "a failed observation write must not fabricate marker advancement"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A service over `source` answering every send `session_missing` at `nowIso`. */
function abandoningService(
  source: FakeSource,
  nowIso: string
): AgentComponentInvocationSyncService {
  return new AgentComponentInvocationSyncService({
    isReady: () => true,
    getSource: () => source,
    getComputeTargetId: () => "target-1",
    sendPart: (pending) =>
      Promise.resolve(
        rejectionAck(
          pending,
          AgentComponentInvocationSyncRejectReason.SessionMissing
        )
      ),
    now: () => new Date(nowIso),
  });
}

/** One rejection ack matching the part it answers. */
function rejectionAck(
  pending: {
    externalGenerationId: string;
    partIndex: number;
    partHash: string;
  },
  reason: AgentComponentInvocationSyncRejectReason
) {
  return {
    kind: "ack" as const,
    ack: {
      accepted: false as const,
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      externalGenerationId: pending.externalGenerationId,
      partIndex: pending.partIndex,
      partHash: pending.partHash,
      reason,
    },
  };
}

/** Import one skill session and promote its generation onto the delivery queue. */
async function seedDeliveryRow(
  db: Db,
  sessionId: string,
  targetSourceKey: string
): Promise<void> {
  await db.importer.importSession(
    skillSession(sessionId, [SKILL_CONTENT_V1]),
    "claude"
  );
  const prepare = db.syncSource.prepareInvocationSyncTarget;
  if (!prepare) {
    throw new Error("the on-disk sync source cannot promote delivery rows");
  }
  await prepare(
    targetSourceKey,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    10
  );
  const seeded = await deliveryRows(db, targetSourceKey, sessionId);
  if (seeded.length !== 1 || seeded[0]?.status !== OutboxStatus.Pending) {
    throw new Error("the fixture must promote exactly one pending part");
  }
}

/**
 * Rewrite the promoted row's `created_at`, which is what the horizon is measured
 * from. The clock stays pinned at {@link NOW} in every case — moving the row is
 * what production does (a row ages), moving the clock is not.
 */
function ageDeliveryRow(
  db: Db,
  targetSourceKey: string,
  sessionId: string,
  createdAt: string
): Promise<number> {
  return db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE agent_component_invocation_sync_outbox
          SET created_at = $1
        WHERE source_key = $2 AND external_session_id = $3`,
      createdAt,
      targetSourceKey,
      sessionId
    )
  );
}

/**
 * Which of the three scanned populations the paging fixture's row `index` belongs
 * to, cycling every third row so no page is homogeneous.
 *
 * A parked row's corruption is the LANE's finding, recorded in `last_error`, and
 * the scan deliberately does not re-derive it from `created_at` — so a parked row
 * here carries a readable one, which also proves the scan is reading the marker
 * rather than re-parsing the timestamp.
 */
function pagedRowState(index: number): {
  status: string;
  lastError: string | null;
  createdAt: string;
} {
  const population = index % 3;
  if (population === 0) {
    return {
      status: OutboxStatus.DeadLettered,
      lastError:
        AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted,
      createdAt: horizonSpentCreatedAt(),
    };
  }
  if (population === 1) {
    return {
      status: OutboxStatus.DeadLettered,
      lastError: AgentComponentInvocationSyncLocalError.CorruptCreatedAt,
      createdAt: horizonSpentCreatedAt(),
    };
  }
  return {
    status: OutboxStatus.Pending,
    lastError: null,
    createdAt: "not-a-timestamp",
  };
}

/** A `created_at` that has exactly outlived the horizon as of {@link NOW}. */
function horizonSpentCreatedAt(): string {
  return new Date(
    Date.parse(NOW) - SESSION_MISSING_MAX_RETRY_AGE_MS
  ).toISOString();
}

/** A `created_at` one second short of outliving the horizon as of {@link NOW}. */
function horizonIntactCreatedAt(): string {
  return new Date(
    Date.parse(NOW) - SESSION_MISSING_MAX_RETRY_AGE_MS + 1000
  ).toISOString();
}
