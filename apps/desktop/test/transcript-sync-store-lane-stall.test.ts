/**
 * @file transcript-sync-store-lane-stall.test.ts
 * @description ISS-8689: what an observation does to the two LANE-STALL fields
 * on a row — the durable stall clock and the pending attempt deadline.
 *
 * Split out of `transcript-sync-store.test.ts` for the reason its own header
 * already records for the recovery cluster: adding this group would push that
 * suite past the 1,000-line file ceiling, and these cases are coherent on their
 * own. They share the same real-libSQL harness in
 * `./helpers/transcript-sync-store-fixtures.js`.
 *
 * The rule under test exists because a revive means "these bytes are new", and
 * neither lane-stall field is about the bytes: the clock measures how long the
 * CLOUD has been unreachable, and the deadline is what the cloud asked for.
 * Resetting either on a local file change is how a backoff gets defeated by the
 * user typing — so the deadline is protected while a stall is open, and the
 * clock is not written here at all.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  redactedArchiveCursorTargetId,
  TRANSCRIPT_LANE_STALL_CEILING_MS,
  TRANSCRIPT_LANE_STALL_RETRY_MS,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  observeInput,
  T0,
  withStore,
} from "./helpers/transcript-sync-store-fixtures.js";

// ISS-8689 LOCK, written before the behavior change it guards.
// `planObservation` resets the backoff whenever an observed file CHANGED, and
// ISS-8689 makes that reset CONDITIONAL: a CONFIGURATION-class stall must keep
// its stand-down, because a growing local transcript does not configure an
// absent bucket. Today's behavior is unconditional, and nothing pinned it while
// a lane stall was open.
//
// This case pins the arm that must NOT change. A widening that let ANY open
// lane stall suppress the re-queue would delay recovery from a real, transient
// outage by up to the stall delay on every row the user is actively writing —
// and it would ship green, because the only existing revive case
// ("a dead file stays dead until it changes, then revives") runs with
// laneStalledSince: null and so never enters this branch at all.
test("ISS-8689: a changed file during a TRANSIENT lane stall still resets the backoff", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 3,
      missingSourceCount: 0,
      dead: false,
      terminalSkipReason: null,
      terminalSkipComputeTargetId: null,
      nextAttemptAt: "2026-07-09T00:05:00.000Z",
      // No configuration marker: this is a plain cloud outage.
      lastError: "/desktop/transcripts/sync-plan returned HTTP 503",
      laneStalledSince: T0,
      now: T0,
    });

    const fp = await store.observe(observeInput({ mtimeMs: 9999, size: 800 }));

    assert.equal(fp.status, "queued", "a changed file re-queues");
    assert.equal(
      fp.nextAttemptAt,
      null,
      "an UNCLASSIFIED lane stall must not hold a changed file back — the cloud may have recovered"
    );
    assert.equal(fp.retryCount, 0, "the ladder resets with it");
    assert.equal(
      fp.laneStalledSince,
      T0,
      "the stall clock itself survives the re-queue, so the 24h ceiling keeps its origin"
    );
  });
});

// ISS-8689 revive rule 1. `recordFailure` is the only thing that OPENS a stall
// run, and every dead settle already closes it — so the only way a row carries a
// clock older than the 24h ceiling is that nothing attempted it while wall time
// ran: the app was quit, the tier was closed, the device was offline. Then the
// user edits the session, the row revives with its counters and backoff reset,
// and its FIRST lane-wide failure reads `now - stalledSince >= ceiling` and
// dead-letters on attempt one instead of getting the fresh 24h a revived row is
// owed. That is the parity gap with `revivedRowData`, which clears the clock on
// the dead-row revive path for exactly this reason.
// ISS-8689: `planObservation` must leave `laneStalledSince` ALONE — on every
// observation, changed or not, spent or live.
//
// This was very nearly the opposite. The dispatch ruling asked for the clock to
// be cleared on revive, on the premise that a dead row re-queues and instantly
// re-dead-letters against a stale origin. That premise does not hold:
// `settleUpdateData` (`transcript-sync-settle.ts`) already nulls the column on
// every `dead` settle and is the only writer that can, so a dead row's clock is
// always null. Building the clear anyway reintroduced the invariant-5 violation
// from the other side — an observation landing on the ceiling crossing before
// the drain does restarts the run, and a file the user keeps writing to pushes
// its own terminal instant forward forever.
//
// Both halves are pinned here because they fail differently. A revive that
// clears is the unreachable-terminal bug; a sweep that clears is the same bug
// corpus-wide, since the 30-minute discovery sweep re-observes every file.
test("ISS-8689: an observation never restarts the lane-stall clock, changed or not", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 0,
      missingSourceCount: 0,
      dead: false,
      terminalSkipReason: null,
      terminalSkipComputeTargetId: null,
      nextAttemptAt: "2026-07-09T00:05:00.000Z",
      lastError: "/desktop/transcripts/sync-plan returned HTTP 503",
      laneStalledSince: T0,
      now: T0,
    });

    // Unchanged: what the 30-minute discovery sweep does to every file.
    const swept = await store.observe(
      observeInput({ now: "2026-07-09T00:31:00.000Z" })
    );
    assert.equal(
      swept.laneStalledSince,
      T0,
      "re-observing an unchanged file is not an event in the stall run"
    );
    assert.equal(
      swept.nextAttemptAt,
      "2026-07-09T00:05:00.000Z",
      "nor may it move the pending attempt"
    );

    // Changed, and a day later — so the clock is SPENT and the next attempt is
    // dead-letter-eligible. Even here the origin is what the ceiling measures
    // from, and the terminal has to stay reachable.
    const revivedAt = new Date(
      Date.parse(T0) + TRANSCRIPT_LANE_STALL_CEILING_MS + 1000
    ).toISOString();
    const revived = await store.observe(
      observeInput({ mtimeMs: 9999, size: 800, now: revivedAt })
    );
    assert.equal(revived.status, "queued", "a changed file still re-queues");
    assert.equal(
      revived.laneStalledSince,
      T0,
      "a spent clock is still the run's origin — only a settle ends a run"
    );
  });
});

test("ISS-8689: a changed file may not shorten an open CONFIGURATION stand-down", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    // What a 503 carrying `Retry-After: 3600` persists: an hour out.
    const standDownUntil = "2026-07-09T01:00:00.000Z";
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 0,
      missingSourceCount: 0,
      dead: false,
      terminalSkipReason: null,
      terminalSkipComputeTargetId: null,
      nextAttemptAt: standDownUntil,
      lastError: "/desktop/transcripts/sync-plan returned HTTP 503",
      laneStalledSince: T0,
      now: T0,
    });

    const fp = await store.observe(
      observeInput({
        mtimeMs: 9999,
        size: 800,
        now: "2026-07-09T00:05:00.000Z",
      })
    );

    assert.equal(
      fp.status,
      "queued",
      "the row still re-queues — nothing is lost"
    );
    assert.equal(
      fp.nextAttemptAt,
      standDownUntil,
      "the hour the server asked for survives the file change; the new bytes go out on the next attempt"
    );
    assert.equal(
      fp.laneStalledSince,
      T0,
      "and the run keeps its origin, so the 24h ceiling still terminates it"
    );
  });
});

// ISS-8689 revive rule 2, the arm that must NOT widen — the counterpart to the
// committed TRANSIENT lock below. A stand-down no longer than the floor is the
// stall's opening rung, when a cloud blip is most likely to have already passed
// and the cost of waiting it out is a delayed healthy row for nothing. Only what
// the schedule or the server pushed BEYOND the floor is honored across a change.
test("ISS-8689: a changed file still clears a stand-down within the lane-stall floor", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 0,
      missingSourceCount: 0,
      dead: false,
      terminalSkipReason: null,
      terminalSkipComputeTargetId: null,
      // Exactly the floor: the first rung, not an escalated stand-down.
      nextAttemptAt: new Date(
        Date.parse(T0) + TRANSCRIPT_LANE_STALL_RETRY_MS
      ).toISOString(),
      lastError: "/desktop/transcripts/sync-plan returned HTTP 503",
      laneStalledSince: T0,
      now: T0,
    });

    const fp = await store.observe(observeInput({ mtimeMs: 9999, size: 800 }));

    assert.equal(
      fp.nextAttemptAt,
      null,
      "a first-rung wait is not a stand-down to protect — the cloud may already be back"
    );
  });
});

// ISS-8689 revive rule 2, the half a REMAINING-WAIT test cannot hold. The rule
// keeps a stand-down that runs past the stall's opening rung, and an hour the
// server asked for qualifies — but only for as long as an hour is still longer
// than the floor. Measured against what is LEFT, the same hour stops qualifying
// at t+55m and the file change clears it, POSTing five minutes before the
// minimum `Retry-After: 3600` states. Anchoring to `laneStalledSince` makes the
// answer time-invariant, and this pins the window where the two disagree: a
// case placed at t+5m (as the sibling above is) passes under either rule and
// would have shipped the defect green.
test("ISS-8689: a Retry-After stand-down is not cut short in its final rung", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput());
    // A 503 carrying `Retry-After: 3600`, persisted at the top of the run.
    const standDownUntil = "2026-07-09T01:00:00.000Z";
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 0,
      missingSourceCount: 0,
      dead: false,
      terminalSkipReason: null,
      terminalSkipComputeTargetId: null,
      nextAttemptAt: standDownUntil,
      lastError: "/desktop/transcripts/sync-plan returned HTTP 503",
      laneStalledSince: T0,
      now: T0,
    });

    // t+55m: exactly one floor of wait remains, so a remaining-wait test reads
    // this as the opening rung and clears it.
    const fp = await store.observe(
      observeInput({
        mtimeMs: 9999,
        size: 800,
        now: "2026-07-09T00:55:00.000Z",
      })
    );

    assert.equal(fp.status, "queued", "the row still re-queues");
    assert.equal(
      fp.nextAttemptAt,
      standDownUntil,
      "the last five minutes of a server minimum are still the server minimum"
    );
  });
});

// ISS-8689: the one revive that is NOT the storm. Every other reason a row
// re-queues is local bytes, which cannot fix a broken cloud — but a compute
// target switch changes WHO the next request goes to, so the failure that set
// this deadline is not the failure the next attempt would meet. Holding the new
// target behind the old one's stand-down makes re-pointing the app take up to a
// full rung to do anything, and a target switch is a sign-in rather than a
// keystroke, so it cannot re-open the request storm the rule exists to close.
test("ISS-8689: a compute-target rewrite clears the previous target's stand-down", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput({ currentComputeTargetId: "ct-1" }));
    await store.recordUploaded({
      externalSessionId: "sess-1",
      fileKey: "main",
      syncedByteOffset: 500,
      syncedSha256: "sha-500",
      storedEtag: "etag-1",
      syncedComputeTargetId: redactedArchiveCursorTargetId("ct-1"),
      caughtUp: true,
      now: T0,
    });
    await store.recordFailure({
      externalSessionId: "sess-1",
      fileKey: "main",
      retryCount: 0,
      missingSourceCount: 0,
      dead: false,
      terminalSkipReason: null,
      terminalSkipComputeTargetId: null,
      // Well past the opening rung: an unchanged file would hold this.
      nextAttemptAt: "2026-07-09T01:00:00.000Z",
      lastError: "/desktop/transcripts/sync-plan returned HTTP 401",
      laneStalledSince: T0,
      now: T0,
    });

    // The FILE is untouched — mtime and size are the fixture defaults. The only
    // thing that changed is the target, so this asserts the rewrite arm alone.
    const fp = await store.observe(
      observeInput({
        currentComputeTargetId: "ct-2",
        now: "2026-07-09T00:05:00.000Z",
      })
    );

    assert.equal(fp.status, "queued", "a target switch re-queues the row");
    assert.equal(
      fp.nextAttemptAt,
      null,
      "the new target does not inherit the old target's stand-down"
    );
    assert.equal(
      fp.laneStalledSince,
      T0,
      "the run still keeps its origin — a rewrite is not a settle"
    );
  });
});
