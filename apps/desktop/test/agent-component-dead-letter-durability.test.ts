/**
 * @file agent-component-dead-letter-durability.test.ts
 * @description ISS-8593 coverage for the DURABILITY half of the component-sync
 * dead-letter tracker, split out of `agent-component-sync-dead-letter.test.ts`
 * (which owns the ISS-4542 state machine) to keep both files under the 1000-line
 * ceiling and to give this contract its own home.
 *
 * What it pins: the snapshot carries each id's `attempts`, `tombstoned` flag and
 * absolute retry deadline; a restart RESUMES that deadline (clamped at both
 * ends) instead of restarting its clock, so time the app spent closed counts;
 * the size cap never evicts an entry nothing else can re-drive, and when it can
 * free no safe slot it refuses the admission AND holds the cursor; and the
 * persisted-record codec rejects the whole impossible set for `attempts` while
 * keeping healthy siblings.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ComponentDeadLetterRecord } from "../src/main/agent-sync/agent-component-dead-letter-persistence.js";
import {
  componentDeadLetterRecordsWereDropped,
  parseComponentDeadLetterRecords,
} from "../src/main/agent-sync/agent-component-dead-letter-persistence.js";
import {
  buildComponentBoundaryKey,
  COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD,
  COMPONENT_DEAD_LETTER_MAX_ATTEMPTS,
  COMPONENT_DEAD_LETTER_RETRY_MAX_MS,
  COMPONENT_MAX_DEAD_LETTERED_IDS,
  ComponentSendFailureOutcome,
  ComponentSyncDeadLetterTracker,
  handleComponentSendFailure,
} from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import { AgentComponentSyncLane } from "../src/main/agent-sync/agent-session-sync-component-lane.js";
import type {
  AgentSessionSyncSource,
  PersistedSyncState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { buildAgentComponentSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  acceptedResult,
  batchRejectedResult,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";

const DRAIN_TARGET = "target-drained-recovery";
const DRAIN_SOURCE_KEY = buildAgentComponentSyncSourceKey(DRAIN_TARGET);
const POISON_ID = "poison-drained";
const POISON_TS = "2026-08-20T10:00:00.000Z";

/** Drive `id` all the way to dead-lettered on its own keyset boundary. */
function deadLetterOnce(
  tracker: ComponentSyncDeadLetterTracker,
  id: string,
  nowMs: number,
  tombstonedIds?: ReadonlySet<string>
): void {
  const boundary = buildComponentBoundaryKey("t", id);
  for (let f = 0; f < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; f++) {
    tracker.recordBatchFailure(boundary, [id], nowMs, tombstonedIds);
  }
}

test("ISS-8593 durability: a restart RESUMES an id's backoff instead of resetting it to due-immediately", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 11_000_000;
  deadLetterOnce(tracker, "a", now);
  // Two failed re-attempts: "a" now sits two rungs up the doubling ladder.
  tracker.noteReattemptResult(["a"], false, now);
  tracker.noteReattemptResult(["a"], false, now);

  const snapshot = tracker.deadLetterState();
  // 10 minutes: the 5-minute base doubled once for the second attempt, written
  // out here rather than read from the ladder under test.
  const SECOND_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
  assert.deepEqual(
    snapshot,
    [
      {
        id: "a",
        attempts: 2,
        tombstoned: false,
        retryAfterEpochMs: now + SECOND_ATTEMPT_WINDOW_MS,
      },
    ],
    "the durable snapshot carries the earned attempt count and the deadline it is waiting on, not just the id"
  );

  // Restart PART-WAY through that window: one minute of it has elapsed.
  const afterRestart = new ComponentSyncDeadLetterTracker();
  const restartAt = now + 60_000;
  afterRestart.seedDeadLetters(
    snapshot.map((record) => record.id),
    restartAt,
    snapshot
  );

  assert.deepEqual(
    afterRestart.takeDueDeadLetters(restartAt, 10),
    [],
    "not due at the instant of the restart — a restart no longer resets the entry to due-immediately"
  );
  assert.deepEqual(
    afterRestart.takeDueDeadLetters(now + SECOND_ATTEMPT_WINDOW_MS - 1, 10),
    [],
    "and still not due one tick before the ORIGINAL deadline"
  );
  assert.deepEqual(
    afterRestart.takeDueDeadLetters(now + SECOND_ATTEMPT_WINDOW_MS, 10),
    ["a"],
    "it comes due at the deadline it was already waiting on — the window is resumed, not restarted"
  );
});

test("ISS-8593 durability: a restart un-quarantines a parked id at its earned backoff, so it is still never permanently stranded", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 12_000_000;
  deadLetterOnce(tracker, "a", now);
  let clock = now;
  for (let i = 0; i < COMPONENT_DEAD_LETTER_MAX_ATTEMPTS; i++) {
    clock += COMPONENT_DEAD_LETTER_RETRY_MAX_MS;
    tracker.noteReattemptResult(["a"], false, clock);
  }
  assert.deepEqual(
    tracker.takeDueDeadLetters(clock + COMPONENT_DEAD_LETTER_RETRY_MAX_MS, 10),
    [],
    "quarantined: parked for the rest of this process lifetime"
  );

  const snapshot = tracker.deadLetterState();
  assert.deepEqual(snapshot, [
    {
      id: "a",
      attempts: COMPONENT_DEAD_LETTER_MAX_ATTEMPTS,
      tombstoned: false,
    },
  ]);

  const afterRestart = new ComponentSyncDeadLetterTracker();
  const restartAt = 90_000_000;
  afterRestart.seedDeadLetters(
    snapshot.map((record) => record.id),
    restartAt,
    snapshot
  );
  // Independently written: five attempts is the 5-minute base doubled four
  // times — 80 minutes, still well under the 24h ceiling.
  const RESUMED_WINDOW_MS = 80 * 60 * 1000;
  assert.deepEqual(
    afterRestart.takeDueDeadLetters(restartAt, 10),
    [],
    "not re-driven at the instant of the restart any more"
  );
  assert.deepEqual(
    afterRestart.takeDueDeadLetters(restartAt + RESUMED_WINDOW_MS, 10),
    ["a"],
    "but the quarantine is NOT restored: it is re-driven once its earned window elapses"
  );
});

test("ISS-8593 cap: a tombstoned entry is retained while re-drivable entries give up their slots", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 13_000_000;
  const tombstone = "uninstalled-1";
  // Admitted FIRST, so under the old oldest-first rule it was the first victim.
  deadLetterOnce(tracker, tombstone, now, new Set([tombstone]));
  for (let i = 0; i < COMPONENT_MAX_DEAD_LETTERED_IDS + 25; i++) {
    deadLetterOnce(tracker, `live-${i}`, now);
  }

  const tracked = tracker.deadLetterState();
  assert.equal(
    tracker.size,
    COMPONENT_MAX_DEAD_LETTERED_IDS,
    "the hard size cap still holds — bounded growth is unchanged"
  );
  assert.ok(
    tracked.some((record) => record.id === tombstone && record.tombstoned),
    "the tombstoned entry was never chosen as a victim: nothing else can re-drive it"
  );
  assert.ok(
    !tracked.some((record) => record.id === "live-0"),
    "the oldest RE-DRIVABLE entry gave up its slot instead — eviction really ran"
  );
  assert.equal(
    tracker.refusedAdmissions,
    0,
    "and no admission had to be refused while re-drivable entries remained"
  );
});

test("ISS-8593 cap: with only tombstones tracked the cap REFUSES the admission rather than evicting one", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 14_000_000;
  const tombstonedIds = new Set<string>();
  for (let i = 0; i < COMPONENT_MAX_DEAD_LETTERED_IDS; i++) {
    const id = `uninstalled-${i}`;
    tombstonedIds.add(id);
    deadLetterOnce(tracker, id, now, tombstonedIds);
  }
  assert.equal(tracker.size, COMPONENT_MAX_DEAD_LETTERED_IDS);
  assert.equal(
    tracker.refusedAdmissions,
    0,
    "nothing refused while the set was still filling"
  );

  deadLetterOnce(tracker, "live-late", now);

  assert.equal(
    tracker.size,
    COMPONENT_MAX_DEAD_LETTERED_IDS,
    "the cap holds: the tracker never grows past it"
  );
  assert.equal(
    tracker.refusedAdmissions,
    1,
    "the incoming id was refused, and the refusal is counted rather than swallowed"
  );
  assert.ok(
    !tracker.deadLetterState().some((record) => record.id === "live-late"),
    "the refused id is the one left untracked"
  );
  assert.equal(
    tracker.deadLetterState().filter((record) => record.tombstoned).length,
    COMPONENT_MAX_DEAD_LETTERED_IDS,
    "every tombstone the tracker already promised to re-drive is still held"
  );
});

test("ISS-8593: handleComponentSendFailure reports a cap refusal on the lane's diagnostic channel", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 15_000_000;
  const tombstonedIds = new Set<string>();
  for (let i = 0; i < COMPONENT_MAX_DEAD_LETTERED_IDS; i++) {
    const id = `uninstalled-${i}`;
    tombstonedIds.add(id);
    deadLetterOnce(tracker, id, now, tombstonedIds);
  }

  const outcomes: string[] = [];
  const diag = {
    note: (_level: "info" | "warn", outcome: string) => {
      outcomes.push(outcome);
    },
    set: (outcome: string) => {
      outcomes.push(outcome);
    },
  };
  let lastOutcome: ComponentSendFailureOutcome =
    ComponentSendFailureOutcome.DeadLettered;
  for (let f = 0; f < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; f++) {
    lastOutcome = handleComponentSendFailure({
      tracker,
      boundaryKey: buildComponentBoundaryKey("t", "live-late"),
      batchIds: ["live-late"],
      componentCount: 1,
      canAdvance: true,
      diag,
    });
  }

  assert.ok(
    outcomes.includes("dead-letter-cap-refused"),
    "a refused admission is named, never silently swallowed"
  );
  assert.equal(
    lastOutcome,
    ComponentSendFailureOutcome.RetryInPlace,
    "and the cursor is HELD: advancing past an id the tracker refused is what would make the loss permanent"
  );
});

test("ISS-8593 persistence: parseComponentDeadLetterRecords keeps a valid record and drops only the impossible ones", () => {
  const valid = { id: "a", attempts: 3, tombstoned: true };
  const impossible: unknown[] = [
    { id: "fractional", attempts: 1.5, tombstoned: false },
    { id: "negative", attempts: -1, tombstoned: false },
    { id: "past-safe-integer", attempts: 2 ** 53, tombstoned: false },
    { id: "infinite", attempts: Number.POSITIVE_INFINITY, tombstoned: false },
    { id: "not-a-number", attempts: Number.NaN, tombstoned: false },
    { id: "numeric-string", attempts: "3", tombstoned: false },
    { id: "", attempts: 1, tombstoned: false },
    { id: "out-of-domain-flag", attempts: 1, tombstoned: 1 },
    { id: "missing-flag", attempts: 1 },
    "a-bare-id",
    null,
  ];
  assert.deepEqual(
    parseComponentDeadLetterRecords([valid, ...impossible]).records,
    [valid],
    "every impossible attempt count is dropped and the healthy sibling survives"
  );
  assert.deepEqual(
    parseComponentDeadLetterRecords(null).records,
    [],
    "an absent column degrades to no bookkeeping (the ids still load separately)"
  );
  assert.deepEqual(
    parseComponentDeadLetterRecords("[]").records,
    [],
    "an unparsed TEXT value is not silently treated as an empty array of records"
  );
});

test("ISS-8593 persistence: an oversized dead_letter_attempts array is bounded before per-entry parsing", () => {
  // The shape a corrupt or version-skewed row actually takes: far more entries
  // than the tracker could ever retain, and every one of them INVALID — so a
  // bound on the output count would still parse the whole payload.
  const oversized = Array.from(
    { length: COMPONENT_MAX_DEAD_LETTERED_IDS * 3 },
    (_unused, index) => ({ id: `id-${index}`, attempts: -1, tombstoned: false })
  );
  let parseCalls = 0;
  const counted = oversized.map((record) => ({
    get id() {
      parseCalls++;
      return record.id;
    },
    attempts: record.attempts,
    tombstoned: record.tombstoned,
  }));

  assert.deepEqual(
    parseComponentDeadLetterRecords(counted).records,
    [],
    "every entry is impossible, so nothing is adopted"
  );
  assert.ok(
    parseCalls <= COMPONENT_MAX_DEAD_LETTERED_IDS,
    `at most the cap is READ (${parseCalls} of ${oversized.length}): entries past it could never have been retained, so parsing them is unbounded main-process work a corrupt row must not be able to spend`
  );

  // The bound must not cost a healthy payload its bookkeeping.
  const healthy = Array.from(
    { length: COMPONENT_MAX_DEAD_LETTERED_IDS },
    (_unused, index) => ({ id: `ok-${index}`, attempts: 1, tombstoned: true })
  );
  assert.equal(
    parseComponentDeadLetterRecords(healthy).records.length,
    COMPONENT_MAX_DEAD_LETTERED_IDS,
    "a payload at the cap is read WHOLE — the bound is the tracker's own size cap, not a smaller one"
  );
});

/** Seed a tracker exactly the way `hydrateCursorFor` does, off one raw persisted
 * value, so these cases pin the composition the lane actually runs rather than a
 * hand-arranged flag. */
function seedFromPersisted(
  ids: readonly string[],
  rawDeadLetterAttempts: unknown,
  reportedDropped?: number
): ComponentSyncDeadLetterTracker {
  const tracker = new ComponentSyncDeadLetterTracker();
  const { records, droppedCount } = parseComponentDeadLetterRecords(
    rawDeadLetterAttempts
  );
  tracker.seedDeadLetters(
    ids,
    20_000_000,
    records,
    componentDeadLetterRecordsWereDropped(reportedDropped) || droppedCount > 0
  );
  return tracker;
}

const tombstonedById = (tracker: ComponentSyncDeadLetterTracker) =>
  new Map(
    tracker.deadLetterState().map((record) => [record.id, record.tombstoned])
  );

test("ISS-8593 (marisolashgrove review): a DROPPED record seeds its id as tombstoned, and a surviving record still speaks for itself", () => {
  // `corrupt` is the row the whole change exists to protect: its record is
  // destroyed, so nothing left in the reply says it was ever tombstoned.
  const seeded = tombstonedById(
    seedFromPersisted(
      ["corrupt", "live", "stone"],
      [
        {
          id: "corrupt",
          attempts: 2,
          tombstoned: true,
          retryAfterEpochMs: 1.5,
        },
        { id: "live", attempts: 1, tombstoned: false },
        { id: "stone", attempts: 1, tombstoned: true },
      ]
    )
  );

  assert.equal(
    seeded.get("corrupt"),
    true,
    "the id whose record the codec refused is PROTECTED: it may be a tombstone, and a tombstone evicted at the cap is gone for good because its ordering key never rises again"
  );
  assert.equal(
    seeded.get("live"),
    false,
    "a record that SURVIVED still decides its own id — the drop signal governs only the unmatched branch, so this is not blanket protection"
  );
  assert.equal(
    seeded.get("stone"),
    true,
    "and a surviving tombstone is protected on its own record, as before"
  );
});

test("ISS-8593 (marisolashgrove review): with NOTHING dropped an unmatched id stays re-drivable, so a legacy cursor is not pinned forever", () => {
  // The pre-migration-0080 shape: ids recorded, no bookkeeping to join to. No
  // record was destroyed here — there was never one to destroy.
  assert.equal(
    tombstonedById(seedFromPersisted(["legacy-a", "legacy-b"], undefined)).get(
      "legacy-a"
    ),
    false,
    "an absent column is not a drop: every id seeds re-drivable, exactly as it did before ISS-8593"
  );

  // A healthy array that simply does not mention every tracked id — the id was
  // dead-lettered after the snapshot was written.
  const seeded = tombstonedById(
    seedFromPersisted(
      ["described", "newer"],
      [{ id: "described", attempts: 1, tombstoned: false }]
    )
  );
  assert.equal(
    seeded.get("newer"),
    false,
    "an id the healthy snapshot never described is re-drivable: fewer records than ids is NOT a drop signal, which is why the count is reported by the codec and never inferred here"
  );
  assert.equal(seeded.get("described"), false, "and its sibling is unchanged");
});

test("ISS-8593 (marisolashgrove review): the STORE's reported drop count fails closed, including when it is unreadable", () => {
  // The case the separate field exists for: every entry was refused, so the
  // records array is empty and OMITTED, while the ids still load.
  assert.equal(
    tombstonedById(seedFromPersisted(["orphan"], undefined, 3)).get("orphan"),
    true,
    "a drop the STORE made is invisible in this reply's records — only its count carries it"
  );
  assert.equal(
    tombstonedById(seedFromPersisted(["orphan"], undefined, 0)).get("orphan"),
    false,
    "a reported zero is a real measurement: nothing was dropped, so nothing is protected"
  );

  for (const unreadable of [-1, 1.5, Number.NaN, 2 ** 53]) {
    assert.equal(
      componentDeadLetterRecordsWereDropped(unreadable),
      true,
      `an unreadable count (${unreadable}) fails CLOSED — it is not evidence that nothing was dropped, and reading it as a measured zero is exactly that`
    );
  }
  assert.equal(
    componentDeadLetterRecordsWereDropped(undefined),
    false,
    "absent is not a fault: the field is optional and additive"
  );
});

test("ISS-8593 persistence: a record naming an untracked id is ignored, and an id with no record seeds at attempt 0", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 16_000_000;
  tracker.seedDeadLetters(["a", "b"], now, [
    { id: "a", attempts: 2, tombstoned: false },
    { id: "vanished", attempts: 4, tombstoned: true },
  ]);

  assert.deepEqual(
    tracker.deadLetterState().map(({ id, attempts, tombstoned }) => ({
      id,
      attempts,
      tombstoned,
    })),
    [
      { id: "a", attempts: 2, tombstoned: false },
      { id: "b", attempts: 0, tombstoned: false },
    ],
    "membership comes from the id list; a record with no id there is ignored and an id with no record seeds fresh"
  );
  assert.deepEqual(
    tracker.takeDueDeadLetters(now, 10),
    ["b"],
    "only the freshly-seeded id is due now — the restored one is inside its resumed window"
  );
});

test("ISS-8593 cap: an entry tombstoned AFTER it was dead-lettered gains eviction protection without losing its backoff", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 17_000_000;
  // Dead-lettered while still installed, then two failed re-attempts.
  deadLetterOnce(tracker, "a", now);
  tracker.noteReattemptResult(["a"], false, now);
  tracker.noteReattemptResult(["a"], false, now);
  assert.deepEqual(
    tracker.deadLetterState().map(({ id, attempts, tombstoned }) => ({
      id,
      attempts,
      tombstoned,
    })),
    [{ id: "a", attempts: 2, tombstoned: false }]
  );

  // The user uninstalls it. The tombstone re-keys the row above the cursor, so
  // the lane reads it again — and fails it again, this time knowing it is a
  // tombstone.
  deadLetterOnce(tracker, "a", now, new Set(["a"]));

  assert.deepEqual(
    tracker.deadLetterState().map(({ id, attempts, tombstoned }) => ({
      id,
      attempts,
      tombstoned,
    })),
    [{ id: "a", attempts: 2, tombstoned: true }],
    "the newly-learned tombstone flag is adopted while the earned attempt count is left alone"
  );

  // And the protection is real, not just recorded: fill the cap with re-drivable
  // entries and the tombstone is still the one that survives.
  for (let i = 0; i < COMPONENT_MAX_DEAD_LETTERED_IDS + 5; i++) {
    deadLetterOnce(tracker, `live-${i}`, now);
  }
  assert.ok(
    tracker
      .deadLetterState()
      .some((record) => record.id === "a" && record.tombstoned),
    "it is no longer an eviction candidate"
  );
});

test("ISS-8593 durability: time the app spent CLOSED counts toward the resumed window, so a short-lived process still re-drives", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 18_000_000;
  deadLetterOnce(tracker, "a", now);
  // Climb to attempt 8: a 640-minute window, far longer than a short app session.
  let clock = now;
  for (let i = 0; i < 8; i++) {
    clock += COMPONENT_DEAD_LETTER_RETRY_MAX_MS;
    tracker.noteReattemptResult(["a"], false, clock);
  }
  const snapshot = tracker.deadLetterState();
  assert.equal(snapshot.length, 1);
  assert.equal(
    snapshot[0].retryAfterEpochMs,
    undefined,
    "a quarantined entry records no finite deadline (Infinity is not a JSON number)"
  );

  // Take an entry that is NOT quarantined so it carries a real deadline.
  const live = new ComponentSyncDeadLetterTracker();
  deadLetterOnce(live, "b", now);
  live.noteReattemptResult(["b"], false, now);
  const [record] = live.deadLetterState();
  // Independently written: the first failed re-attempt's window is the 5-minute base.
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  assert.equal(
    record.retryAfterEpochMs,
    now + FIVE_MINUTES_MS,
    "the absolute deadline is what gets persisted, not a duration"
  );

  // The app closes and reopens LATER than that deadline: the entry is due at once.
  const afterLongClose = new ComponentSyncDeadLetterTracker();
  const reopenLate = now + FIVE_MINUTES_MS + 1;
  afterLongClose.seedDeadLetters(["b"], reopenLate, [record]);
  assert.deepEqual(
    afterLongClose.takeDueDeadLetters(reopenLate, 10),
    ["b"],
    "a deadline that elapsed while the app was closed comes back due — closed time counts"
  );

  // The app reopens BEFORE the deadline: only the remainder is waited out.
  const afterShortClose = new ComponentSyncDeadLetterTracker();
  const reopenEarly = now + 60_000;
  afterShortClose.seedDeadLetters(["b"], reopenEarly, [record]);
  assert.deepEqual(
    afterShortClose.takeDueDeadLetters(now + FIVE_MINUTES_MS - 1, 10),
    [],
    "still inside the original window"
  );
  assert.deepEqual(
    afterShortClose.takeDueDeadLetters(now + FIVE_MINUTES_MS, 10),
    ["b"],
    "and due at the ORIGINAL deadline, not one full window after the restart"
  );
});

test("ISS-8593 durability: a far-future or corrupt deadline is clamped to one window, never a permanent park", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 19_000_000;
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  // A backwards clock change or a hand-edited row: a deadline a year out.
  tracker.seedDeadLetters(["a"], now, [
    {
      id: "a",
      attempts: 1,
      tombstoned: true,
      retryAfterEpochMs: now + YEAR_MS,
    },
  ]);
  // Independently written: attempt 1's window is the 5-minute base, which is the
  // most the clamp will honor.
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  assert.deepEqual(
    tracker.takeDueDeadLetters(now + FIVE_MINUTES_MS - 1, 10),
    [],
    "the entry is genuinely held for its own window, not waved through"
  );
  assert.deepEqual(
    tracker.takeDueDeadLetters(now + FIVE_MINUTES_MS, 10),
    ["a"],
    "and the year-long deadline is clamped to that window — a bogus instant can delay, never strand"
  );
});

test("ISS-8593 persistence: seedDeadLetters tolerates a non-array records value from the db-host boundary", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 20_000_000;
  // The component lane parses before seeding, but the tracker must not be the
  // thing that throws a TypeError into the lane's tick if that ever regresses.
  tracker.seedDeadLetters(["a"], now, "not-an-array" as never);
  assert.deepEqual(
    tracker.deadLetterState().map((record) => record.id),
    ["a"],
    "the ids still seed; only their bookkeeping degrades"
  );
});

/**
 * ISS-8593 (whitlockk review): a lane over a MUTABLE in-memory `sync_state` store,
 * so a spec can tear the lane down and build a NEW one over the SAME durable
 * row — a restart, rather than a read-back inside the process that wrote it.
 *
 * `sendComponents` is switchable because the two halves of the drained-cursor
 * contract need opposite recovery outcomes from the same fixture: a rejection
 * (which advances `attempts`) and an acceptance (which removes the entry).
 */
function makeDrainedLaneFixture(durableRows: Map<string, PersistedSyncState>) {
  const uploads: string[][] = [];
  let accept = false;
  const source = {
    loadSyncState: (key: string) =>
      Promise.resolve(durableRows.get(key) ?? null),
    advanceSyncState: (key: string, state: PersistedSyncState) => {
      durableRows.set(key, state);
      return Promise.resolve();
    },
  } as unknown as AgentSessionSyncSource;

  const lane = new AgentComponentSyncLane(
    {
      getSource: () => source,
      getSyncComputeTargetId: () => DRAIN_TARGET,
      listComponentCursorRows: (sinceTs: string, sinceId: string) =>
        Promise.resolve(
          POISON_TS > sinceTs || (POISON_TS === sinceTs && POISON_ID > sinceId)
            ? [{ id: POISON_ID, last_seen_at: POISON_TS }]
            : []
        ),
      loadComponentRows: (ids: string[]) =>
        Promise.resolve(ids.map((id) => syncedFor(id, POISON_TS))),
      sendComponents: (payload) => {
        uploads.push(payload.components.map((c) => c.externalId));
        return Promise.resolve(
          accept ? acceptedResult() : batchRejectedResult()
        );
      },
    },
    { getSourceStateGeneration: () => 1, isStarted: () => true }
  );

  return {
    uploads,
    acceptFromNowOn(): void {
      accept = true;
    },
    async runTick(): Promise<void> {
      await lane.syncOnce();
      await lane.whenCursorPersistSettled();
    },
  };
}

/** Records on the durable row, keyed by id, after whatever ran last. */
function durableRecordFor(
  durableRows: Map<string, PersistedSyncState>,
  id: string
): ComponentDeadLetterRecord | undefined {
  const state = durableRows.get(DRAIN_SOURCE_KEY);
  return parseComponentDeadLetterRecords(
    state?.deadLetterAttempts
  ).records.find((record) => record.id === id);
}

/**
 * Drive the poison row to dead-lettered (the cursor advances past it, which is
 * what persists the first snapshot), then drain once so the recovery pass runs.
 */
async function driveToPostRecoveryDrain(
  fixture: ReturnType<typeof makeDrainedLaneFixture>
): Promise<void> {
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    await fixture.runTick();
  }
  await fixture.runTick();
}

test("ISS-8593 (whitlockk review): a FAILED drained re-attempt persists the advanced backoff, so a restart does not re-attempt too soon", async () => {
  const durableRows = new Map<string, PersistedSyncState>();
  const first = makeDrainedLaneFixture(durableRows);
  await driveToPostRecoveryDrain(first);

  // The recovery pass re-attempted the id and was rejected, so the entry is now
  // one attempt further along its ladder. That happened entirely in memory; the
  // durable row is the only place it can survive the process.
  assert.equal(
    durableRecordFor(durableRows, POISON_ID)?.attempts,
    1,
    "the failed re-attempt reached the durable row (recovery advances no cursor, so nothing else would carry it)"
  );

  // RESTART: a new lane over the same durable row, nothing shared in memory.
  const restarted = makeDrainedLaneFixture(durableRows);
  await restarted.runTick();
  await restarted.runTick();

  assert.deepEqual(
    restarted.uploads,
    [],
    "the restarted lane resumes the earned backoff window instead of re-attempting immediately"
  );
});

test("ISS-8593 (whitlockk review): a SUCCEEDED drained re-attempt persists the removal, so a restart does not re-send a component that already made it", async () => {
  const durableRows = new Map<string, PersistedSyncState>();
  const first = makeDrainedLaneFixture(durableRows);
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    await first.runTick();
  }
  // The entry is dead-lettered at attempts 0 — due immediately once drained.
  first.acceptFromNowOn();
  await first.runTick();

  assert.equal(
    durableRows.get(DRAIN_SOURCE_KEY)?.deadLetteredIds?.includes(POISON_ID),
    false,
    "the id that reached the cloud left the durable membership record too"
  );

  const restarted = makeDrainedLaneFixture(durableRows);
  await restarted.runTick();
  await restarted.runTick();

  assert.deepEqual(
    restarted.uploads,
    [],
    "the restarted lane does not re-seed and re-send a component the previous process already delivered"
  );
});
