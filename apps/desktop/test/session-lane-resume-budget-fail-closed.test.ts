/**
 * @file session-lane-resume-budget-fail-closed.test.ts
 * @description ISS-8594 — the SERVICE pass, driven end to end.
 *
 * `db-host-reply-boundary.test.ts` covers the reader and `resumeSessionOutboxEngineState`
 * in isolation, and `persisted-cursor-hydration-coverage.test.ts` covers the
 * hydration seam. Neither reaches the line in the grandfathered
 * `agent-session-sync-service.ts` that ABANDONS the pass, and that line is the
 * whole ticket: un-hydrating alone left the identity unchanged, so nothing else
 * abandoned the pass and it ran on to candidate selection and uploaded against
 * empty budget maps — the FEA-3659 bug shape reached through the error path.
 *
 * So a helper-level assertion of "seeded 0" is green against the code as it was
 * and proves nothing. Every case below drives the real `AgentSessionSyncService`
 * and asserts what reached the cloud, so reverting the abort fails a named test
 * rather than passing every unit around it.
 *
 * Started with `historicalBackfill: false` for the same reason
 * `db-host-reply-boundary-resume-wiring.test.ts` is: it takes
 * `reconcilePendingOutboxIfIdle` out of the picture, so what the lane sends is
 * decided by the resume path rather than rescued by a sibling loop.
 *
 * The service scaffolding (`settle`, the accepting service, `sentIds`, the
 * telemetry capture) is shared with that suite in
 * `agent-session-sync-service-fixture.ts`: this file was born holding a verbatim
 * copy of it, and two files disagreeing about what "the pass settled" means is
 * how one of them starts asserting against an idle lane.
 */
import assert from "node:assert/strict";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { afterEach, beforeEach, test } from "vitest";
import type { AgentSessionSyncBatch } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import {
  buildAgentSessionSyncSourceKey,
  type SessionOutboxEngineState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  DB_HOST_REPLY_REJECTED_CATEGORY,
  resetDbHostReplyRejectionThrottle,
} from "../src/main/telemetry/db-host-reply-rejection.js";
import { DbHostRejectedReplyOp } from "../src/main/telemetry/telemetry-protocol.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  armTelemetry,
  makeAcceptingService as makeService,
  sentIds,
  settle,
} from "./agent-session-sync-service-fixture.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "resume-budget-target";
/** The identity the service actually resolves for `COMPUTE_TARGET`. */
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);
const DEFERRED_ID = "deferred-1";
/** A session the cursor has NOT seen, so the incremental scan selects it. */
const FRESH_ID = "fresh-after-cursor";
const TOP_UPDATED_AT = "2026-07-20T00:00:00.000Z";
const AFTER_TOP_UPDATED_AT = "2026-07-21T00:00:00.000Z";
/** Far enough ahead that a rehydrated deadline still defers on the next tick. */
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

// The monitored rejection facet is throttled per op by module-level state, so a
// case asserting a SECOND rejection would otherwise read the previous case's
// claim and pass in file order while failing run alone.
beforeEach(() => {
  resetDbHostReplyRejectionThrottle();
});

let restoreTelemetry: (() => void) | null = null;
afterEach(() => {
  restoreTelemetry?.();
  restoreTelemetry = null;
});

/** Arm the telemetry lane for one case, restored unconditionally in `afterEach`. */
function captureTelemetry(): ReturnType<typeof armTelemetry>["events"] {
  const armed = armTelemetry();
  restoreTelemetry = armed.restore;
  return armed.events;
}

/** The ops this suite's monitored facet reported, in emission order. */
function rejectedOps(
  events: ReturnType<typeof captureTelemetry>
): (string | undefined)[] {
  return events
    .filter((event) => event.category === DB_HOST_REPLY_REJECTED_CATEGORY)
    .map((event) => event.diagnostics?.dbHostReplyRejected?.op);
}

function makeAcceptingService(
  source: FakeSyncSource,
  sent: AgentSessionSyncBatch[]
): AgentSessionSyncService {
  return makeService(source, sent, COMPUTE_TARGET);
}

/** What the db host answers for the Nth retry-state read of a run. */
type RetryReadScript = (
  readIndex: number,
  real: () => SessionOutboxEngineState[] | Promise<SessionOutboxEngineState[]>
) => unknown;

/**
 * A source whose durable retry-state read follows a script. Counts the reads, so
 * a case can prove the resume was actually RE-ATTEMPTED rather than succeeding
 * on a first call it never made.
 */
class ScriptedRetryStateSource extends FakeSyncSource {
  reads = 0;
  script: RetryReadScript = (_readIndex, real) => real();

  override loadPendingSessionOutboxEngineState(
    sourceKey: string
  ): SessionOutboxEngineState[] | Promise<SessionOutboxEngineState[]> {
    this.reads += 1;
    // The cast is the point of the fixture, not a shortcut around it: the static
    // type says this must be an `SessionOutboxEngineState[]`, and the db-host boundary
    // is exactly where that stops being true.
    return this.script(this.reads, () =>
      super.loadPendingSessionOutboxEngineState(sourceKey)
    ) as SessionOutboxEngineState[];
  }
}

test("ISS-8617: fake retry-state selector treats explicit null stall state as zero-state", async () => {
  const source = new FakeSyncSource([]);
  await source.enqueueOutboxEntries(SOURCE_KEY, [
    {
      externalSessionId: "zero-state",
      syncClass: AgentSessionSyncMode.Backfill,
    },
  ]);

  const row = [...source.outbox.values()].find(
    (entry) => entry.id === "zero-state"
  );
  assert.equal(row?.status, OutboxStatus.Pending);
  assert.ok(row, "queued row exists in the fake source");
  row.laneStalledSince = null;

  assert.deepEqual(
    await source.loadPendingSessionOutboxEngineState(SOURCE_KEY),
    [],
    "explicit null matches SQLite's lane_stalled_since IS NOT NULL selector"
  );

  row.laneStalledSince = "2026-07-20T00:00:00.000Z";
  assert.deepEqual(
    await source.loadPendingSessionOutboxEngineState(SOURCE_KEY),
    [
      {
        id: "zero-state",
        attemptCount: 0,
        permanentAttemptCount: 0,
        deadLetterRecoveryCount: 0,
        nextAttemptAt: null,
        lastError: null,
        laneStalledSince: "2026-07-20T00:00:00.000Z",
      },
    ]
  );
});

/**
 * Seed the durable state a kill-then-restart leaves behind, with the row already
 * MID-BACKOFF: a persisted cursor whose watermark covers the session (so neither
 * a full walk nor the incremental scan re-selects it), plus a still-`pending`
 * outbox row carrying `attempt_count = 4` and a future `next_attempt_at`.
 *
 * That is the population the ticket is about. Resume is the only thing that can
 * put the row back on a queue, and the budget read is the only thing that can
 * tell the lane it is still inside its backoff window.
 */
async function seedDeferredRow(source: FakeSyncSource): Promise<void> {
  source.advanceSyncState(SOURCE_KEY, {
    observedTopUpdatedAt: TOP_UPDATED_AT,
    observedIdsAtTopUpdatedAt: [DEFERRED_ID],
    deadLetteredIds: [],
  });
  await source.enqueueOutboxEntries(SOURCE_KEY, [
    { externalSessionId: DEFERRED_ID, syncClass: "backfill" },
  ]);
  source.recordOutboxRetry(
    SOURCE_KEY,
    DEFERRED_ID,
    4,
    FAR_FUTURE,
    "ingestion_failed",
    null
  );
}

/**
 * A source carrying the mid-backoff row and a session the cursor has NOT seen.
 *
 * The unseen one is the discriminator every case below leans on: it is what the
 * incremental scan selects on a pass that gets past hydration, so "the pass was
 * abandoned" and "the pass ran and deferred the row" stop being the same
 * observation.
 */
async function seededSource(): Promise<ScriptedRetryStateSource> {
  const source = new ScriptedRetryStateSource([
    makeSyncedSession(DEFERRED_ID, TOP_UPDATED_AT),
    makeSyncedSession(FRESH_ID, AFTER_TOP_UPDATED_AT),
  ]);
  await seedDeferredRow(source);
  return source;
}

/** A source seeded as above, scripted to skew read `onRead`. */
async function scriptedSource(
  onRead: number,
  reply: unknown
): Promise<ScriptedRetryStateSource> {
  const source = await seededSource();
  source.script = (readIndex, real) => (readIndex === onRead ? reply : real());
  return source;
}

test("fail closed: a THROWING budget read sends nothing, seeds no budget, and leaves the identity un-hydrated", async () => {
  const source = await seededSource();
  source.script = (readIndex) => {
    if (readIndex === 1) {
      throw new Error("sync_state table is locked");
    }
    return [];
  };
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeAcceptingService(source, sent);

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.equal(source.reads, 1, "the budget read ran");
  // The assertion the whole ticket turns on. Before ISS-8594 the pass continued
  // past this point with empty budget maps, so the mid-backoff row had no
  // deadline deferring it, was selected immediately, and its next rejection
  // recomputed `attempt_count` as 1 — dodging the persisted backoff AND the
  // dead-letter cap together.
  assert.deepEqual(
    sentIds(sent),
    [],
    "nothing is sent on a tick whose budget read failed"
  );
  service.stop();
});

test("fail closed: an UNREADABLE budget reply sends nothing, for every unreadable shape", async () => {
  // Both doors into the same state, neither of which throws: a reply that is not
  // an array at all, and an array of rows this build cannot parse. The second is
  // the one a version-skewed peer actually produces.
  const unreadable: readonly unknown[] = [
    { rows: [] },
    [{ id: 7, attemptCount: "4", nextAttemptAt: 0 }],
  ];
  for (const reply of unreadable) {
    const source = await scriptedSource(1, reply);
    const sent: AgentSessionSyncBatch[] = [];
    const service = makeAcceptingService(source, sent);

    service.start({ historicalBackfill: false });
    await settle(service);

    assert.equal(source.reads, 1, "the budget read ran");
    assert.deepEqual(
      sentIds(sent),
      [],
      `expected ${JSON.stringify(reply)} to abandon the pass, not read as an empty outbox`
    );
    service.stop();
  }
});

test("fail closed: the next tick RECOVERS — the pass runs and sends, and the deferred row stays deferred by its persisted deadline", async () => {
  // The failure must be transient-recoverable, not a wedge: the identity was
  // left un-hydrated, so a later tick re-reads. Recovery is asserted on the
  // SEND, not on the read count — a permanently-wedged lane re-reads on every
  // tick too, and `sentIds === []` plus a retained pending row are both equally
  // true of a wedge, so a case pinned on those three would pass unchanged if
  // recovery never happened. `FRESH_ID` is past the cursor and carries no
  // budget, so it can only reach the transport from a pass that got past
  // hydration; `DEFERRED_ID` staying behind is what proves the recovered budget
  // was actually seeded rather than skipped.
  const source = await scriptedSource(1, { rows: [] });
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeAcceptingService(source, sent);

  service.start({ historicalBackfill: false });
  await settle(service);
  assert.deepEqual(sentIds(sent), [], "the failed tick sent nothing");

  service.refresh();
  await settle(service);
  service.refresh();
  await settle(service);

  assert.ok(
    source.reads >= 2,
    "the identity was re-armed and the budget read retried"
  );
  assert.deepEqual(
    sentIds(sent),
    [FRESH_ID],
    "the recovered pass delivered the session that carries no persisted budget"
  );
  assert.deepEqual(
    source.pendingOutboxIds(SOURCE_KEY),
    [DEFERRED_ID],
    "and the mid-backoff row is deferred by its persisted next_attempt_at, not sent and not lost"
  );
  service.stop();
});

test("fail closed: a THROWING read abandons the pass WITHOUT claiming the peer answered a bad shape", async () => {
  // The two doors into `ReadFailed` are not the same event. The unreadable arm
  // is reported by the boundary reader as a refused REPLY; a throw produced no
  // reply to refuse, and that facet's message says one was. Attributing a thrown
  // read to it would put a false claim on a monitored facet — the shape of
  // defect this ticket exists to remove — so the throw arm abandons the pass and
  // leaves the wedge to `detectNoProgressStall`, which reads the lane's durable
  // remainder rather than anything this pass touched.
  const events = captureTelemetry();
  const source = await seededSource();
  source.script = (readIndex) => {
    if (readIndex === 1) {
      throw new Error("no such column: lane_stalled_since");
    }
    return [];
  };
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeAcceptingService(source, sent);

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.deepEqual(sentIds(sent), [], "the throwing tick sent nothing");
  assert.deepEqual(
    rejectedOps(events),
    [],
    "a throw is not a refused reply and must not be counted as one"
  );
  service.stop();
});

test("fail closed: a PERSISTENT failure reports once per window, not once per 5s tick", async () => {
  // ISS-8594 made a failed budget read retract the once-per-identity marker, so
  // the read now re-runs on EVERY tick instead of once per identity. Without a
  // throttle that is ~12 `severity: "error"` emissions a minute, per device, for
  // as long as the fault lasts — on the facet whose whole purpose is to be
  // alertable. `resumeSessionOutboxEngineState`'s own warn is deliberately still per
  // tick — pinned in `db-host-reply-boundary.test.ts` — and only the monitored
  // emit is bounded; the reporter itself writes no local line at all.
  const events = captureTelemetry();
  const source = await seededSource();
  source.script = () => ({ rows: [] });
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeAcceptingService(source, sent);

  service.start({ historicalBackfill: false });
  await settle(service);
  service.refresh();
  await settle(service);
  service.refresh();
  await settle(service);

  assert.ok(source.reads >= 3, "every tick re-attempted the failing read");
  assert.deepEqual(
    rejectedOps(events),
    [DbHostRejectedReplyOp.LoadPendingSessionOutboxEngineState],
    "a wedge that spans many ticks is one monitored event, not one per tick"
  );
  service.stop();
});

test("fail closed: a failed PENDING-IDS read abandons the pass too — the third abort condition", async () => {
  // `requeueResumeOutboxIds` answers `false` for a thrown or unreadable
  // `loadPendingOutboxIds` reply, and ISS-8594 changed what that `false` costs:
  // the caller now abandons the pass on it, where before it only left the
  // identity un-hydrated and ran on to selection. `FRESH_ID` is the observable —
  // it needs no resume state of its own, so a pass that carried on would have
  // delivered it.
  const source = await seededSource();
  let idReads = 0;
  source.loadPendingOutboxIds = (): string[] => {
    idReads += 1;
    if (idReads === 1) {
      throw new Error("database is locked");
    }
    return [DEFERRED_ID];
  };
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeAcceptingService(source, sent);

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.equal(idReads, 1, "the pending-ids read ran");
  assert.deepEqual(
    sentIds(sent),
    [],
    "nothing is sent on a tick whose un-acked prefix was never re-enqueued"
  );
  assert.equal(
    source.reads,
    0,
    "and the budget read never ran — the pass stopped at the failed prefix read"
  );
  service.stop();
});

test("fail closed: a healthy EMPTY outbox still lets the pass proceed and SEND (positive sibling)", async () => {
  // Without this the suite passes with the lane hard-wired off. An empty budget
  // is a real answer — nothing is mid-backoff — and must not read as a failed
  // read, so a fresh session enqueued this tick has to reach the cloud.
  const source = new ScriptedRetryStateSource([
    makeSyncedSession("fresh-1", TOP_UPDATED_AT),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeAcceptingService(source, sent);

  service.start();
  await settle(service);

  assert.deepEqual(
    sentIds(sent),
    ["fresh-1"],
    "an empty budget completes the resume and the lane sends"
  );
  service.stop();
});
