/**
 * @file db-host-reply-boundary.test.ts
 * @description ISS-8115 — the db-host `invoke` reply path delivers the child's
 * structured clone VERBATIM and the main side is a single cast on a forwarding
 * Proxy, so every field main reads from the db host is trusted on an assertion
 * about the peer rather than a fact about the bytes.
 *
 * That makes malformed and unknown input REACHABLE at this boundary, which is
 * why these cases are written at all: the types forbid them in-process, and the
 * types are not what runs here.
 *
 * Three subjects, each covered at two layers:
 *  1. the boundary reader itself (round trip, unknown keys, malformed), and
 *  2. the PRODUCTION path that consumes it, so deleting the call site cannot
 *     leave the suite green.
 *
 * Every refusal below has a positive sibling on the same subject, so none can
 * pass by simply never accepting anything.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  buildSessionPresenceProbe,
  decideHydrationAbsence,
  HydrationAbsenceVerdict,
  probeSessionPresence,
} from "../src/main/agent-sync/agent-session-hydration-absence.js";
import { MAX_OBSERVED_TOP_IDS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type {
  PersistedSyncState,
  SessionOutboxEngineState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { readPersistedSyncState } from "../src/main/agent-sync/persisted-sync-state-reply-boundary.js";
import {
  OutboxResumeOutcome,
  resumeSessionOutboxEngineState,
} from "../src/main/agent-sync/session-outbox-engine-state.js";
import {
  readPendingSessionOutboxEngineState,
  readSessionPresenceIds,
} from "../src/main/agent-sync/sync-source-reply-boundary.js";
import {
  DB_HOST_REPLY_REJECTED_CATEGORY,
  DB_HOST_REPLY_REJECTION_THROTTLE_MS,
  resetDbHostReplyRejectionThrottle,
} from "../src/main/telemetry/db-host-reply-rejection.js";
import { Observability } from "../src/main/telemetry/observability.js";
import type { TelemetryEventPayload } from "../src/main/telemetry/telemetry-protocol.js";
import { DbHostRejectedReplyOp } from "../src/main/telemetry/telemetry-protocol.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  flushAgentSessionSync,
  makeServiceWithIdentity,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

/**
 * Record what reaches the telemetry lane, restoring the singleton exactly.
 *
 * Assigns the original back rather than deleting the key: `getTelemetryEmitter`
 * is a `static`, so it is an own property of the class itself and deleting it
 * would remove the method outright for every later test in this process.
 */
function captureTelemetry(sink: TelemetryEventPayload[]): () => void {
  const original = Observability.getTelemetryEmitter;
  Observability.getTelemetryEmitter = () => ({
    emit: (event: TelemetryEventPayload) => {
      sink.push(event);
    },
  });
  return () => {
    Observability.getTelemetryEmitter = original;
  };
}

let restoreTelemetry: (() => void) | null = null;
afterEach(() => {
  restoreTelemetry?.();
  restoreTelemetry = null;
});

// The monitored rejection facet is throttled per op by module-level state that
// outlives a case, so a later case asserting the same op would read an earlier
// one's claim — green in file order, red run alone.
beforeEach(() => {
  resetDbHostReplyRejectionThrottle();
});

// Nothing resets a fake clock for you, so a case that pins it and throws before
// restoring it would freeze `Date.now` for every later case in this worker.
// Unconditional, not a last line.
afterEach(() => {
  nodeTestTimers.reset();
});

/** Arm the capture and hand back the sink. */
function armTelemetry(): TelemetryEventPayload[] {
  const sink: TelemetryEventPayload[] = [];
  restoreTelemetry = captureTelemetry(sink);
  return sink;
}

/** The "this source has no probe at all" half of `probeSessionPresence`'s failure text. */
const NO_PROBE_FAILURE = /exposes no/;

/**
 * ISS-8116: these cases exercise the boundary READER, not the identity
 * lifecycle, so the pass is stated live. The discard-on-switch behaviour has its
 * own coverage in `agent-session-sync-pass-identity-guards.test.ts`.
 */
const LIVE_SOURCE_STATE = () => true;

/** The warn line `resumeSessionOutboxEngineState` states when its durable read failed. */
const FAILED_RETRY_READ = /failed to load pending outbox retry state/;

/** The op paths a rejection was reported against, in order. */
function rejectedOps(sink: TelemetryEventPayload[]): unknown[] {
  return sink
    .filter((event) => event.category === DB_HOST_REPLY_REJECTED_CATEGORY)
    .map((event) => event.diagnostics?.dbHostReplyRejected?.op);
}

/* ------------------------------------------------------------------ *
 * 1. findExistingSessionIds — the disposal proof
 * ------------------------------------------------------------------ */

/**
 * Hand-written, NOT derived from the schema that polices it: this is what the
 * db-host child actually answers for a two-id probe.
 */
const PRESENT_IDS = ["session-alpha", "session-beta"];

test("presence ids: a real id list survives the boundary, including through a structured clone", () => {
  const sink = armTelemetry();
  assert.deepEqual(readSessionPresenceIds(PRESENT_IDS), PRESENT_IDS);
  assert.deepEqual(
    readSessionPresenceIds(structuredClone(PRESENT_IDS)),
    PRESENT_IDS
  );
  // An empty list is a POSITIVE claim (a probe ran, nothing is present), not a
  // fault. It must travel, or the disposal path can never be reached at all.
  assert.deepEqual(readSessionPresenceIds([]), []);
  assert.deepEqual(rejectedOps(sink), [], "no rejection for well-formed input");
});

test("presence ids: every unreadable reply degrades to ABSENCE-NOT-ESTABLISHED, never to an empty present-set", () => {
  const sink = armTelemetry();
  const malformed: readonly unknown[] = [
    null,
    42,
    0,
    "session-alpha",
    "",
    true,
    false,
    {},
    { ids: ["session-alpha"] },
    [1, 2, 3],
    ["session-alpha", null],
    ["session-alpha", 7],
    [["session-alpha"]],
    new Set(PRESENT_IDS),
    new Map(),
  ];
  for (const value of malformed) {
    // The monitored emit is throttled per op, so a loop that walks many shapes
    // of ONE op inside one window would otherwise report only the first. Each
    // shape is a separate fault here, so each gets its own window.
    resetDbHostReplyRejectionThrottle();
    assert.equal(
      readSessionPresenceIds(value),
      undefined,
      `expected ${JSON.stringify(String(value))} to establish nothing`
    );
  }
  assert.equal(
    rejectedOps(sink).length,
    malformed.length,
    "each rejection is reported once"
  );
  assert.deepEqual(
    new Set(rejectedOps(sink)),
    new Set([DbHostRejectedReplyOp.FindExistingSessionIds]),
    "reported against the op whose reply was refused"
  );
});

test("presence ids: a `null` reply must not dispose of the queued sessions (ISS-8115 regression)", async () => {
  armTelemetry();
  // `new Set(null)` is an EMPTY SET rather than a throw, so before the boundary
  // schema this arrived as `ok: true` with no ids — which reads as "a probe ran
  // and found no row for any of them" and DROPS the only copy of the data.
  // No cast: ISS-8115 widened the probe callback to `unknown`, so a peer that
  // answers `null` is now expressible in the type system instead of being a
  // case the annotation claimed could not happen.
  const probe = await probeSessionPresence(() => null);
  assert.equal(probe.ok, false, "a null reply establishes nothing");

  const decision = decideHydrationAbsence(PRESENT_IDS, probe);
  assert.deepEqual(decision.disposableIds, [], "nothing may be disposed of");
  assert.deepEqual(decision.retryIds, PRESENT_IDS, "everything is retried");
  assert.equal(decision.verdict, HydrationAbsenceVerdict.Unverified);
});

test("presence ids: a genuine empty probe still CONFIRMS absence (positive sibling)", async () => {
  armTelemetry();
  // The sibling of the case above, and the reason it cannot be satisfied by
  // refusing everything: a real probe that really found nothing must still reach
  // the disposal path, or ISS-6031's fix would have replaced destruction with a
  // queue that never drains.
  const probe = await probeSessionPresence(() => []);
  assert.equal(probe.ok, true);

  const decision = decideHydrationAbsence(PRESENT_IDS, probe);
  assert.deepEqual(decision.disposableIds, PRESENT_IDS);
  assert.deepEqual(decision.retryIds, []);
  assert.equal(decision.verdict, HydrationAbsenceVerdict.ConfirmedAbsent);
});

test("presence ids: a source exposing no probe is not reported as a version-skew fault", async () => {
  const sink = armTelemetry();
  // Absence is the CALLBACK being absent. `buildSessionPresenceProbe` returns
  // `undefined` for a source with no delegate, and that is what a legacy or fake
  // source produces.
  const probe = await probeSessionPresence(
    buildSessionPresenceProbe({}, PRESENT_IDS)
  );
  assert.equal(probe.ok, false);
  assert.match(probe.ok === false ? probe.failure : "", NO_PROBE_FAILURE);
  assert.deepEqual(
    rejectedOps(sink),
    [],
    "a legacy/fake source behaving as designed is not a monitored fault"
  );
});

test("presence ids: a probe that EXISTS and answers `undefined` IS a fault", async () => {
  const sink = armTelemetry();
  // The sibling of the case above, and the distinction the production caller's
  // optional chaining used to destroy: `source.findExistingSessionIds?.(ids)`
  // yields `undefined` for a missing delegate AND for a delegate that returned
  // nothing. Both reached "this source exposes no probe", so a peer that had
  // silently stopped answering an op this build calls was filed as a legacy
  // source with nothing to say, and never counted.
  const probe = await probeSessionPresence(
    buildSessionPresenceProbe({ findExistingSessionIds: () => undefined }, [])
  );
  assert.equal(probe.ok, false, "still establishes nothing — nothing is lost");
  assert.equal(
    probe.ok === false && NO_PROBE_FAILURE.test(probe.failure),
    false,
    "and it is NOT attributed to a source that exposes no probe"
  );
  assert.deepEqual(
    rejectedOps(sink),
    [DbHostRejectedReplyOp.FindExistingSessionIds],
    "an invoked op answering outside its contract reaches the monitored facet"
  );
});

test("presence ids: the probe builder invokes the delegate as a MEMBER call", async () => {
  armTelemetry();
  // Not a style point: in the db-host build `source` is the FEA-2038 forwarding
  // Proxy, whose `get` trap answers `call`/`apply`/`bind` with `undefined`, so a
  // detached reference throws. `this` must still be the source.
  const source = {
    ids: PRESENT_IDS,
    findExistingSessionIds(): unknown {
      return this.ids;
    },
  };
  const probe = await probeSessionPresence(
    buildSessionPresenceProbe(source, PRESENT_IDS)
  );
  assert.equal(probe.ok, true);
  assert.deepEqual(probe.ok === true ? probe.presentIds : [], PRESENT_IDS);
});

/* ------------------------------------------------------------------ *
 * 2. loadSyncState — the durable upload cursor
 * ------------------------------------------------------------------ */

/** Hand-written: a resumable cursor as the db-host child actually persists it. */
const CURSOR: PersistedSyncState = {
  observedTopUpdatedAt: "2026-08-24T00:00:00.000Z",
  observedIdsAtTopUpdatedAt: ["session-alpha", "session-beta"],
  deadLetteredIds: ["session-gamma"],
};

test("sync cursor: a real cursor survives the boundary, including through a structured clone", () => {
  const sink = armTelemetry();
  assert.deepEqual(readPersistedSyncState(CURSOR), CURSOR);
  assert.deepEqual(readPersistedSyncState(structuredClone(CURSOR)), CURSOR);
  // A cursor that has never observed a top row is a real state, not a fault.
  const fresh: PersistedSyncState = {
    observedTopUpdatedAt: null,
    observedIdsAtTopUpdatedAt: [],
    deadLetteredIds: [],
  };
  assert.deepEqual(readPersistedSyncState(fresh), fresh);
  assert.deepEqual(rejectedOps(sink), []);
});

test("sync cursor: `null` means no cursor and is NOT reported as a fault", () => {
  const sink = armTelemetry();
  // The contract itself answers null on a fresh store / first run after upgrade.
  assert.equal(readPersistedSyncState(null), null);
  assert.deepEqual(rejectedOps(sink), []);
});

test("sync cursor: `undefined` is NOT `null` — an invoked op answering nothing is a fault", () => {
  const sink = armTelemetry();
  // The delegate is declared `PersistedSyncState | null`, and the production
  // caller checks `source.loadSyncState` EXISTS before invoking it — so a reply
  // reaching this reader came from an op that genuinely ran, and `undefined` is
  // outside its own contract. It degrades to the same full backfill `null` does,
  // because that is safe either way, but only one of the two is a fault: folding
  // them together makes a peer that has silently stopped answering this op look
  // exactly like a fresh install with nothing to resume.
  assert.equal(
    readPersistedSyncState(undefined),
    null,
    "still degrades safely"
  );
  assert.deepEqual(
    rejectedOps(sink),
    [DbHostRejectedReplyOp.LoadSyncState],
    "but it is counted, where `null` is not"
  );
});

test("sync cursor: a NEWER peer's extra key rides through — the schema is loose, not strict", () => {
  const sink = armTelemetry();
  // The whole reason this boundary is loose: a `.strict()` schema would reject
  // the ENTIRE cursor over one key it was never taught, forcing a full backfill
  // on every resume against a newer child, and re-doing it every time.
  const richer = {
    ...CURSOR,
    observedSpanExtentRevision: 3,
    somethingThisBuildHasNeverHeardOf: { nested: true },
  };
  const parsed = readPersistedSyncState(richer);
  assert.notEqual(parsed, null, "an unknown key must not cost the cursor");
  assert.equal(parsed?.observedTopUpdatedAt, CURSOR.observedTopUpdatedAt);
  assert.deepEqual(
    parsed?.observedIdsAtTopUpdatedAt,
    CURSOR.observedIdsAtTopUpdatedAt
  );
  assert.deepEqual(parsed?.deadLetteredIds, CURSOR.deadLetteredIds);
  assert.deepEqual(rejectedOps(sink), [], "an unknown key is not a fault");
});

test("sync cursor: every unreadable cursor degrades to a full backfill, never to a half-trusted watermark", () => {
  const sink = armTelemetry();
  const malformed: readonly unknown[] = [
    42,
    "2026-08-24T00:00:00.000Z",
    true,
    [],
    [CURSOR],
    {},
    // A known field of the wrong type — each one alone.
    { ...CURSOR, observedTopUpdatedAt: 1_756_000_000_000 },
    { ...CURSOR, observedIdsAtTopUpdatedAt: null },
    { ...CURSOR, observedIdsAtTopUpdatedAt: "session-alpha" },
    { ...CURSOR, observedIdsAtTopUpdatedAt: [7] },
    { ...CURSOR, deadLetteredIds: null },
    { ...CURSOR, deadLetteredIds: {} },
    { ...CURSOR, deadLetteredIds: [null] },
    // Missing required fields.
    { observedTopUpdatedAt: CURSOR.observedTopUpdatedAt },
    {
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: [],
    },
  ];
  for (const value of malformed) {
    // Per-shape window — see the presence-ids loop above.
    resetDbHostReplyRejectionThrottle();
    assert.equal(
      readPersistedSyncState(value),
      null,
      `expected ${JSON.stringify(value)} to degrade to no-cursor`
    );
  }
  assert.equal(rejectedOps(sink).length, malformed.length);
  assert.deepEqual(
    new Set(rejectedOps(sink)),
    new Set([DbHostRejectedReplyOp.LoadSyncState])
  );
});

test("sync cursor: a valid watermark paired with an unreadable observed-id set is refused WHOLE", () => {
  const sink = armTelemetry();
  // Salvaging the readable half would advance the watermark past a tied-timestamp
  // cluster whose observed-id set is unknown — exactly the skip the incremental
  // query's `NOT IN (<observedTopIds>)` arm exists to prevent. The three fields
  // are one decision.
  const halfReadable = {
    observedTopUpdatedAt: "2026-08-24T00:00:00.000Z",
    observedIdsAtTopUpdatedAt: "not-an-array",
    deadLetteredIds: [],
  };
  assert.equal(readPersistedSyncState(halfReadable), null);
  assert.deepEqual(rejectedOps(sink), [DbHostRejectedReplyOp.LoadSyncState]);
});

test("sync cursor: a watermark that is a STRING but not a canonical instant is refused", () => {
  const sink = armTelemetry();
  // `sessions.updated_at` is a TEXT column and the incremental query compares it
  // RAW (`WHERE updated_at > $1`), so ordering is LEXICAL. Each value below is a
  // JS string — a `typeof` check passes every one — and each sorts ABOVE every
  // canonical `2026-…` stamp, so the scan matches nothing while the truthy
  // watermark also suppresses the full backfill. The lane then re-persists the
  // same poisoned value: wedged across restarts, with no rejection to show for it.
  const nonCanonical: readonly string[] = [
    "zzzz",
    "9999-invalid",
    "",
    "not-a-timestamp",
    // SQLite's `datetime('now')` space form — the FEA-3232 review caught this
    // one sorting BELOW same-date ISO stamps, the opposite failure.
    "2026-08-24 00:00:00",
  ];
  for (const observedTopUpdatedAt of nonCanonical) {
    // Per-shape window — see the presence-ids loop above.
    resetDbHostReplyRejectionThrottle();
    assert.equal(
      readPersistedSyncState({ ...CURSOR, observedTopUpdatedAt }),
      null,
      `expected ${JSON.stringify(observedTopUpdatedAt)} to degrade to no-cursor`
    );
  }
  assert.equal(rejectedOps(sink).length, nonCanonical.length);

  // Positive sibling on the same field, so this cannot pass by refusing every
  // string: the forms `Date#toISOString` and `chunkWatermark` actually produce
  // must still resume.
  const clean = armTelemetry();
  for (const observedTopUpdatedAt of [
    "2026-08-24T00:00:00.000Z",
    "2026-08-24T00:00:00Z",
  ]) {
    assert.equal(
      readPersistedSyncState({ ...CURSOR, observedTopUpdatedAt })
        ?.observedTopUpdatedAt,
      observedTopUpdatedAt
    );
  }
  assert.deepEqual(rejectedOps(clean), []);
});

test("sync cursor: an observed-id set past the writer's own cap is refused", () => {
  const sink = armTelemetry();
  // Every id becomes one positional SQLite bind in `listUpdatedSessionCursorRows`'
  // `id NOT IN (…)` expansion, so an unbounded array walks past
  // SQLITE_MAX_VARIABLE_NUMBER and THROWS out of the sync tick. The bound is the
  // writer's own `capPersistedTopIds` cap, imported rather than restated, so a
  // healthy peer can never answer more than this.
  const overCap = Array.from(
    { length: MAX_OBSERVED_TOP_IDS + 1 },
    (_, index) => `session-${index}`
  );
  assert.equal(
    readPersistedSyncState({ ...CURSOR, observedIdsAtTopUpdatedAt: overCap }),
    null
  );
  assert.deepEqual(rejectedOps(sink), [DbHostRejectedReplyOp.LoadSyncState]);

  // Positive sibling: a set AT the cap is exactly what a saturated healthy
  // writer persists, so it must still resume.
  const clean = armTelemetry();
  const atCap = overCap.slice(0, MAX_OBSERVED_TOP_IDS);
  assert.equal(
    readPersistedSyncState({ ...CURSOR, observedIdsAtTopUpdatedAt: atCap })
      ?.observedIdsAtTopUpdatedAt.length,
    MAX_OBSERVED_TOP_IDS
  );
  assert.deepEqual(rejectedOps(clean), []);
});

/* ------------------------------------------------------------------ *
 * 3. loadPendingSessionOutboxEngineState — the persisted retry budget
 * ------------------------------------------------------------------ */

/** Hand-written: two pending rows as the db-host child actually returns them. */
const RETRY_ROWS: SessionOutboxEngineState[] = [
  {
    id: "session-alpha",
    attemptCount: 3,
    permanentAttemptCount: 0,
    deadLetterRecoveryCount: 0,
    ackOmittedCycleCount: 0,
    nextAttemptAt: "2026-08-24T00:05:00.000Z",
    lastError: "ingestion_failed",
    laneStalledSince: "2026-08-23T23:00:00.000Z",
  },
  {
    id: "session-beta",
    attemptCount: 1,
    permanentAttemptCount: 0,
    deadLetterRecoveryCount: 0,
    ackOmittedCycleCount: 0,
    nextAttemptAt: null,
    lastError: null,
    laneStalledSince: null,
  },
];

test("retry state: legacy and current telemetry op names share the same wire value", () => {
  assert.equal(
    DbHostRejectedReplyOp.LoadPendingOutboxRetryState,
    DbHostRejectedReplyOp.LoadPendingSessionOutboxEngineState
  );
});

test("retry state: real rows survive the boundary, including through a structured clone", () => {
  const sink = armTelemetry();
  assert.deepEqual(readPendingSessionOutboxEngineState(RETRY_ROWS), RETRY_ROWS);
  assert.deepEqual(
    readPendingSessionOutboxEngineState(structuredClone(RETRY_ROWS)),
    RETRY_ROWS
  );
  // An empty budget is a real answer (nothing pending), not a fault.
  assert.deepEqual(readPendingSessionOutboxEngineState([]), []);
  assert.deepEqual(rejectedOps(sink), []);
});

test("retry state: dead-lettered row status survives the boundary", () => {
  const sink = armTelemetry();
  const rows = [
    { ...RETRY_ROWS[0], status: OutboxStatus.DeadLettered },
  ] satisfies SessionOutboxEngineState[];

  assert.deepEqual(readPendingSessionOutboxEngineState(rows), rows);
  assert.deepEqual(rejectedOps(sink), []);
});

test("retry state: a NEWER peer's extra key rides through — the schema is loose, not strict", () => {
  const sink = armTelemetry();
  const richer = [
    { ...RETRY_ROWS[0], lastAttemptDurationMs: 1200, laneGeneration: 4 },
  ];
  const parsed = readPendingSessionOutboxEngineState(richer);
  assert.equal(parsed?.length, 1, "an unknown key must not cost the row");
  assert.equal(parsed?.[0]?.id, RETRY_ROWS[0]?.id);
  assert.equal(parsed?.[0]?.attemptCount, RETRY_ROWS[0]?.attemptCount);
  assert.deepEqual(rejectedOps(sink), []);
});

test("retry state: an older peer that omits the ISS-8617 / ISS-9182 durable counters defaults them to zero", () => {
  const sink = armTelemetry();
  const oldPeerRows = RETRY_ROWS.map((row) => ({
    id: row.id,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    laneStalledSince: row.laneStalledSince,
  }));

  assert.deepEqual(
    readPendingSessionOutboxEngineState(oldPeerRows),
    RETRY_ROWS
  );
  assert.deepEqual(rejectedOps(sink), []);
});

// ISS-8594 renamed this expectation because the BEHAVIOR changed, not because
// the assertion was wrong: a failed budget read now FAILS the resume instead of
// degrading to an unseeded budget. `[]` and "unreadable" were the same value
// here, so the caller could not tell a healthy empty outbox from a peer that
// answered nothing readable, and it carried on against empty budget maps.
test("retry state: every unreadable reply answers UNREADABLE, distinct from an empty budget", () => {
  const sink = armTelemetry();
  const malformed: readonly unknown[] = [
    null,
    undefined,
    42,
    "rows",
    true,
    {},
    { rows: RETRY_ROWS },
    [null],
    [42],
    ["session-alpha"],
    [{ ...RETRY_ROWS[0], id: 7 }],
    [{ ...RETRY_ROWS[0], attemptCount: "3" }],
    [{ ...RETRY_ROWS[0], nextAttemptAt: 1_756_000_000_000 }],
    [{ ...RETRY_ROWS[0], lastError: {} }],
    [{ ...RETRY_ROWS[0], laneStalledSince: false }],
    // One good row and one bad one: the array is refused WHOLE, because a
    // half-seeded budget resumes some rows on the persisted deadline and their
    // siblings on a fresh one, and nothing downstream can tell them apart.
    [RETRY_ROWS[0], { ...RETRY_ROWS[1], attemptCount: null }],
  ];
  for (const value of malformed) {
    // Per-shape window — see the presence-ids loop above.
    resetDbHostReplyRejectionThrottle();
    assert.equal(
      readPendingSessionOutboxEngineState(value),
      undefined,
      `expected ${JSON.stringify(value)} to answer UNREADABLE, not an empty budget`
    );
  }
  assert.equal(rejectedOps(sink).length, malformed.length);
  assert.deepEqual(
    new Set(rejectedOps(sink)),
    new Set([DbHostRejectedReplyOp.LoadPendingSessionOutboxEngineState])
  );
});

test("retry state: an attempt count that is a NUMBER but not a nonnegative integer is refused", () => {
  const sink = armTelemetry();
  // `attempt_count` is an `Int` column compared against the integer
  // `MAX_CONSECUTIVE_*` thresholds and then incremented. Every value below is a
  // JS number, so a `typeof` check passes all of them, and each corrupts the
  // budget silently: `4.5` increments to `5.5` and crosses a `>= 5` threshold a
  // whole attempt early (dead-lettering a live row), a negative count seeds a
  // budget that never reaches its threshold at all, and past
  // `Number.MAX_SAFE_INTEGER` the increment stops changing the value.
  const badCounts: readonly number[] = [
    4.5,
    -1,
    -0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 2,
  ];
  for (const attemptCount of badCounts) {
    // Per-shape window — see the presence-ids loop above.
    resetDbHostReplyRejectionThrottle();
    assert.equal(
      readPendingSessionOutboxEngineState([{ ...RETRY_ROWS[0], attemptCount }]),
      undefined,
      `expected ${String(attemptCount)} to answer UNREADABLE`
    );
  }
  assert.equal(rejectedOps(sink).length, badCounts.length);

  // Positive siblings on the same field, so this cannot pass by refusing every
  // number. `0` is a real persisted count (the column's own default), and a
  // count ABOVE every threshold is not malformed — it is a row that genuinely
  // exhausted its budget, and dead-lettering it is the correct terminal state.
  const clean = armTelemetry();
  for (const attemptCount of [0, 3, 9999]) {
    assert.equal(
      readPendingSessionOutboxEngineState([
        { ...RETRY_ROWS[0], attemptCount },
      ])?.[0]?.attemptCount,
      attemptCount
    );
  }
  assert.deepEqual(rejectedOps(clean), []);
});

test("retry state: ISS-8617 durable counters reject malformed numeric values", () => {
  const sink = armTelemetry();
  const badCounts: readonly number[] = [
    4.5,
    -1,
    -0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 2,
  ];
  const fields = [
    "permanentAttemptCount",
    "deadLetterRecoveryCount",
    "ackOmittedCycleCount",
  ] as const;

  for (const field of fields) {
    for (const value of badCounts) {
      resetDbHostReplyRejectionThrottle();
      assert.equal(
        readPendingSessionOutboxEngineState([
          { ...RETRY_ROWS[0], [field]: value },
        ]),
        undefined,
        `expected ${field}=${String(value)} to answer UNREADABLE`
      );
    }
  }
  assert.equal(rejectedOps(sink).length, fields.length * badCounts.length);

  const clean = armTelemetry();
  assert.deepEqual(
    readPendingSessionOutboxEngineState([
      {
        ...RETRY_ROWS[0],
        permanentAttemptCount: 6,
        deadLetterRecoveryCount: 2,
      },
    ]),
    [
      {
        ...RETRY_ROWS[0],
        permanentAttemptCount: 6,
        deadLetterRecoveryCount: 2,
      },
    ]
  );
  assert.deepEqual(rejectedOps(clean), []);
});

/* ------------------------------------------------------------------ *
 * 4. The monitored path itself
 * ------------------------------------------------------------------ */

test("a refused reply reaches the MONITORED lane, carrying its op at error severity", () => {
  const sink = armTelemetry();
  readPersistedSyncState({ observedTopUpdatedAt: 42 });

  const event = sink.find(
    (candidate) => candidate.category === DB_HOST_REPLY_REJECTED_CATEGORY
  );
  assert.ok(event, "the rejection must be emitted on the telemetry transport");
  assert.equal(
    event.severity,
    "error",
    "a peer this build cannot read is an error-severity facet"
  );
  assert.equal(
    event.diagnostics?.dbHostReplyRejected?.op,
    DbHostRejectedReplyOp.LoadSyncState
  );
});

test("a persistently-failing op reports once per window, then RE-ARMS; a sibling op is never silenced by it", () => {
  // ISS-8594 made a failed resume read retract the once-per-identity marker, so
  // the read re-runs on every 5s tick instead of once per identity — ~12
  // `severity: "error"` emissions a minute, per device, for as long as the
  // fault lasts, on the facet whose whole purpose is to be alertable. The
  // repeats carry no information the first does not: the event is the op path
  // and nothing else, deliberately, so two are byte-identical.
  //
  // The clock is pinned rather than slept on: the window is minutes long, and
  // the re-arm below is the half a wall-clock test could not reach at all.
  nodeTestTimers.enable(["Date"], { now: 0 });
  const sink = armTelemetry();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    readPendingSessionOutboxEngineState({ rows: [] });
  }
  assert.deepEqual(
    rejectedOps(sink),
    [DbHostRejectedReplyOp.LoadPendingSessionOutboxEngineState],
    "a fault that spans many ticks is one monitored event"
  );

  // The throttle is PER OP, not global: a second op failing during the first
  // one's window is a different fault and must still be reported.
  readPersistedSyncState({ observedTopUpdatedAt: 42 });
  assert.deepEqual(
    rejectedOps(sink),
    [
      DbHostRejectedReplyOp.LoadPendingSessionOutboxEngineState,
      DbHostRejectedReplyOp.LoadSyncState,
    ],
    "one op's window must not silence another op's first rejection"
  );

  // Throttled, not latched: a wedge that outlives the window is reported again,
  // so the facet keeps showing a live fault instead of one event at its start.
  nodeTestTimers.tick(DB_HOST_REPLY_REJECTION_THROTTLE_MS);
  readPendingSessionOutboxEngineState({ rows: [] });
  assert.deepEqual(
    rejectedOps(sink),
    [
      DbHostRejectedReplyOp.LoadPendingSessionOutboxEngineState,
      DbHostRejectedReplyOp.LoadSyncState,
      DbHostRejectedReplyOp.LoadPendingSessionOutboxEngineState,
    ],
    "the window re-arms rather than suppressing the op for the life of the process"
  );
});

test("the refusal carries the op path and NOTHING from the rejected value", () => {
  const sink = armTelemetry();
  // The premise of the rejection is that the value could not be trusted, so
  // none of it may leave the machine.
  readPersistedSyncState({
    observedTopUpdatedAt: 42,
    observedIdsAtTopUpdatedAt: ["secret-session-id"],
    deadLetteredIds: ["another-secret-id"],
  });

  const event = sink.find(
    (candidate) => candidate.category === DB_HOST_REPLY_REJECTED_CATEGORY
  );
  assert.ok(event);
  const serialized = JSON.stringify(event);
  assert.equal(
    serialized.includes("secret-session-id"),
    false,
    "no part of the rejected reply may travel"
  );
  assert.equal(serialized.includes("another-secret-id"), false);
  assert.deepEqual(Object.keys(event.diagnostics?.dbHostReplyRejected ?? {}), [
    "op",
  ]);
});

/* ------------------------------------------------------------------ *
 * 5. resumeSessionOutboxEngineState — the production caller of the retry reader
 * ------------------------------------------------------------------ */

/** A rehydration target whose seeded state and log lines are both inspectable. */
function retryTarget() {
  const counters = {
    ackOmitted: new Map<string, number>(),
    ackTimeout: new Map<string, number>(),
    unknownAckReason: new Map<string, number>(),
    ingestionFailed: new Map<string, number>(),
    rateLimited: new Map<string, number>(),
    validationFailed: new Map<string, number>(),
  };
  const info: string[] = [];
  const warn: string[] = [];
  return {
    counters,
    info,
    warn,
    target: {
      counters,
      nextRetryAfterMs: new Map<string, number>(),
      laneStalledSinceMsById: new Map<string, number>(),
      deadLetterRecoveryCountById: new Map<string, number>(),
      ackOmittedCycleById: new Map<string, number>(),
      deadLetteredIds: new Set<string>(),
      logInfo: (message: string) => info.push(message),
      logWarn: (message: string) => warn.push(message),
      reportInvalidStallClock: () => {
        // Not the subject here; ISS-7730 owns its own coverage.
      },
    },
  };
}

test("resume: a real reply seeds the persisted retry budget (positive sibling)", async () => {
  armTelemetry();
  const { counters, target, warn } = retryTarget();
  const result = await resumeSessionOutboxEngineState(
    () => RETRY_ROWS,
    target,
    LIVE_SOURCE_STATE
  );

  assert.equal(result.outcome, OutboxResumeOutcome.Seeded);
  assert.equal(result.seeded, 2);
  assert.equal(counters.ingestionFailed.get("session-alpha"), 3);
  assert.deepEqual(warn, [], "a clean resume states no failure");
});

test("resume: a healthy EMPTY outbox is SEEDED, not a failed read", async () => {
  armTelemetry();
  const { target, warn } = retryTarget();
  // The distinction ISS-8594 turns on. `[]` still completes the resume and lets
  // the caller carry on; without this the whole change reads as "any zero seeds
  // fails the pass", which would wedge every device with nothing mid-backoff.
  const result = await resumeSessionOutboxEngineState(
    () => [],
    target,
    LIVE_SOURCE_STATE
  );

  assert.equal(result.outcome, OutboxResumeOutcome.Seeded);
  assert.equal(result.seeded, 0);
  assert.deepEqual(warn, [], "an empty budget is a real answer, not a failure");
});

test("resume: a non-array reply is a FAILED READ, not a seeded-nothing resume", async () => {
  const sink = armTelemetry();
  const { counters, target, warn } = retryTarget();
  // The regression this extraction pins: the service's own try/catch covered
  // only the `await`, so a non-array reply threw from `rehydrateSessionOutboxEngineState`'s
  // `for...of` — outside the guard — and took identity hydration with it.
  const result = await resumeSessionOutboxEngineState(
    () => ({ rows: RETRY_ROWS }),
    target,
    LIVE_SOURCE_STATE
  );

  // ISS-8594: the count is still 0, but the OUTCOME is what the caller acts on.
  // A failed budget read now fails the resume instead of degrading to an
  // unseeded budget, so this arm no longer reads as a healthy empty outbox.
  assert.equal(result.outcome, OutboxResumeOutcome.ReadFailed);
  assert.equal(result.seeded, 0);
  assert.equal(counters.ingestionFailed.size, 0, "no partial seeding");
  assert.match(warn[0] ?? "", FAILED_RETRY_READ);
  assert.deepEqual(rejectedOps(sink), [
    DbHostRejectedReplyOp.LoadPendingSessionOutboxEngineState,
  ]);
});

test("ISS-8116: a retry-state load that resolves under a superseded identity seeds nothing", async () => {
  armTelemetry();
  const { counters, target } = retryTarget();
  // The interleaving davetho named on PR #6104: `stop()` clears the lane's
  // single-flight flag, so a pass for a NEW identity runs start-to-finish while
  // this load is outstanding. Seeding then puts the OLD identity's backoff,
  // stall clocks and dead-letter set into the maps the live pass is reading.
  let release: (rows: SessionOutboxEngineState[]) => void = () => undefined;
  const parked = new Promise<SessionOutboxEngineState[]>((resolve) => {
    release = resolve;
  });
  let identityIsCurrent = true;
  const seeding = resumeSessionOutboxEngineState(
    () => parked,
    target,
    () => identityIsCurrent
  );

  identityIsCurrent = false;
  release(RETRY_ROWS);
  const result = await seeding;

  // ISS-8594: a superseded pass is DISCARDED, never `ReadFailed`. The read
  // landed; the identity moved. The caller's own identity guard owns it, and
  // this arm keeps exactly the behavior it had before that ticket.
  assert.equal(result.outcome, OutboxResumeOutcome.Discarded);
  assert.equal(result.seeded, 0, "a superseded load seeds nothing");
  assert.equal(counters.ingestionFailed.size, 0);
  assert.equal(
    target.nextRetryAfterMs.size,
    0,
    "and re-arms no backoff the new identity would inherit"
  );
  assert.equal(target.deadLetteredIds.size, 0);
});

// ISS-8594 renamed this expectation because the BEHAVIOR changed: a failed
// budget read now FAILS the resume instead of degrading to an unseeded budget.
// The warn-sink assertion is unchanged and still load-bearing.
test("resume: a load that THROWS is a FAILED READ and says so on the warn sink", async () => {
  const sink = armTelemetry();
  const { target, info, warn } = retryTarget();
  const result = await resumeSessionOutboxEngineState(
    () => {
      throw new Error("sync_state table is locked");
    },
    target,
    LIVE_SOURCE_STATE
  );

  assert.equal(result.outcome, OutboxResumeOutcome.ReadFailed);
  assert.equal(result.seeded, 0);
  assert.equal(warn.length, 1, "a failed read is stated");
  assert.match(warn[0] ?? "", FAILED_RETRY_READ);
  assert.deepEqual(
    info,
    [],
    "nothing was seeded, so nothing is reported seeded"
  );
  // A throw is the delegate failing, not a peer answering an unreadable shape:
  // it must NOT be attributed to the boundary schema's monitored facet.
  assert.deepEqual(rejectedOps(sink), []);
});

/* ------------------------------------------------------------------ *
 * 6. AgentSessionSyncService — the cursor reader's production caller
 * ------------------------------------------------------------------ */

/**
 * The wiring proof for `readPersistedSyncState`, driven through the real
 * service rather than the reader alone.
 *
 * Section 2 proves the READER refuses a poisoned watermark. That stays green if
 * the call in `hydratePersistedCursorIfNeeded` is ever bypassed and the raw IPC
 * value reaches hydration unfiltered, which is the failure this asserts against:
 * the malformed cursor below is truthy, so an unguarded hydration seeds it as
 * the watermark AND skips the full backfill, and the corpus never uploads.
 */
test("service: a malformed persisted cursor still full-backfills the corpus", async () => {
  armTelemetry();
  const source = new FakeSyncSource([
    makeSyncedSession("historic-1", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("historic-2", "2026-06-08T12:02:00.000Z"),
  ]);
  // Not expressible through `seedSyncState`, which is typed to the contract —
  // and the contract is exactly what a version-skewed peer is not bound by.
  // `"zzzz"` sorts above every canonical stamp, so an unguarded resume queues
  // nothing, forever.
  source.loadSyncState = () =>
    ({
      observedTopUpdatedAt: "zzzz",
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: [],
    }) as unknown as PersistedSyncState;

  const sent: string[] = [];
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(...batch.sessions.map((s) => s.externalSessionId));
      return Promise.resolve({ accepted: true });
    },
    "target-malformed-cursor"
  );

  service.start();
  for (let index = 0; index < 5; index += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  assert.deepEqual(
    sent.sort(),
    ["historic-1", "historic-2"],
    "an unreadable cursor must fall back to the full backfill, not resume on it"
  );
});

test("service: a CANONICAL persisted cursor still resumes and skips the backfill", async () => {
  armTelemetry();
  // The positive sibling for the test above: without it, deleting the whole
  // resume path would leave that assertion green while breaking every healthy
  // cold start.
  const source = new FakeSyncSource([
    makeSyncedSession("historic-1", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("historic-2", "2026-06-08T12:02:00.000Z"),
  ]);
  source.seedSyncState(buildAgentSessionSyncSourceKey("target-clean-cursor"), {
    observedTopUpdatedAt: "2026-06-08T12:02:00.000Z",
    observedIdsAtTopUpdatedAt: ["historic-2"],
  });

  const sent: string[] = [];
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(...batch.sessions.map((s) => s.externalSessionId));
      return Promise.resolve({ accepted: true });
    },
    "target-clean-cursor"
  );

  service.start();
  for (let index = 0; index < 5; index += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  assert.deepEqual(
    sent,
    [],
    "a fully-synced canonical cursor must not re-upload history"
  );
});
