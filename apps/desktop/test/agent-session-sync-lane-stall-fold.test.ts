/**
 * @file agent-session-sync-lane-stall-fold.test.ts
 * @description ISS-7730 unit coverage for the `ingestion_failed` fold — the
 * lane-wide class that defers with every retry budget intact (`sync/AGENTS.md`
 * invariant 4) and is bounded instead by a durable wall clock (invariant 5).
 *
 * The three cases below are deliberately able to fail INDEPENDENTLY, because the
 * pair of invariants can be satisfied one-at-a-time by two different broken
 * implementations, and each looks like success from the other's side:
 *
 *  - Removing the bound outright passes "a 5xx no longer dead-letters" and fails
 *    "a genuinely stalled lane still terminates".
 *  - Leaving the old counter in place passes "a stalled lane terminates" and
 *    fails "a 5xx no longer dead-letters".
 *
 * The clock is pinned with the lane's own `runWithMockedNow` throughout, at a
 * fixed ORIGIN — a wall-clock bound is exactly where a real-clock assertion
 * would be worthless, and the ceiling arithmetic needs a hand-written expected
 * instant to compare against.
 */

import assert from "node:assert/strict";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import {
  MAX_TRACKED_LANE_STALLS,
  RATE_LIMIT_BACKOFF_MS,
  SESSION_LANE_STALL_CEILING_MS,
  SESSION_LANE_STALL_RETRY_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { createSessionFoldRunners } from "../src/main/agent-sync/agent-session-sync-fold-runners.js";
import {
  SESSION_ENVIRONMENTAL_DEFER_POLICY,
  SessionEnvironmentalDeferClass,
} from "../src/main/agent-sync/agent-session-sync-lane-stall-fold.js";
import { pickReadyCandidates } from "../src/main/agent-sync/agent-session-sync-progress-counts.js";
import {
  TRANSCRIPT_LANE_STALL_CEILING_MS,
  TRANSCRIPT_LANE_STALL_RETRY_MS,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import { LANE_STALL_MAX_RETRY_MS } from "../src/shared/lane-stall-clock.js";
import {
  foldOnce,
  foldRunnerViewStub,
  makeRecordingDeps,
  NOW_MS,
  ORIGIN_ISO,
} from "./agent-session-sync-lane-stall-fixtures.js";
import { runWithMockedNow } from "./agent-session-sync-service-fixtures.js";

test("ISS-7730: an unclassified 5xx defers with its budget intact, far past the retired 5-attempt cap", async () => {
  await runWithMockedNow(async ({ advance }) => {
    const { deps, deadLettered, stallWrites, infos } = makeRecordingDeps();
    const attemptsById = new Map<string, number>();
    const stalledSinceMsById = new Map<string, number>();

    // Twelve consecutive rejections — more than double the retired
    // MAX_CONSECUTIVE_INGESTION_FAILED of 5 — all inside the ceiling.
    const rounds = 12;
    for (let round = 0; round < rounds; round += 1) {
      await foldOnce(deps, attemptsById, stalledSinceMsById);
      advance(SESSION_LANE_STALL_RETRY_MS + 1);
    }

    assert.equal(
      deadLettered.length,
      0,
      "no number of lane-wide 5xx rejections may exhaust a row budget (invariant 4)"
    );
    assert.equal(
      attemptsById.get("s1"),
      rounds,
      "the tally still rises — it is evidence of how hard the lane tried, not a budget"
    );
    assert.equal(stallWrites.length, rounds, "every defer is durably recorded");
    assert.equal(
      new Set(stallWrites.map((write) => write.laneStalledSince)).size,
      1,
      "the clock marks the START of the run and must hold still, or the ceiling is never reached"
    );
    assert.equal(
      stallWrites[0].laneStalledSince,
      new Date(NOW_MS).toISOString(),
      "the run is stamped at the first failure"
    );
    assert.equal(
      stallWrites.at(-1)?.reason,
      "ingestion_failed",
      "a still-deferring row records the ack reason, so a resume re-seeds the same tally"
    );
    assert.equal(infos.length, rounds, "each deferral is logged once");
  }, NOW_MS);
});

test("ISS-7730: the replacement wall-clock bound still terminates a genuinely stalled lane", async () => {
  await runWithMockedNow(async ({ advance }) => {
    const { deps, cleared, deadLettered, dequeued, warnings } =
      makeRecordingDeps();
    const attemptsById = new Map<string, number>([["s1", 3]]);
    const stalledSinceMsById = new Map<string, number>();

    // Start the run, then jump the whole ceiling and fail once more.
    await foldOnce(deps, attemptsById, stalledSinceMsById);
    assert.equal(deadLettered.length, 0, "one rung in, nothing terminal yet");

    advance(SESSION_LANE_STALL_CEILING_MS);
    await foldOnce(deps, attemptsById, stalledSinceMsById);

    assert.deepEqual(deadLettered, [
      {
        id: "s1",
        recoverable: true,
        reason: "ingestion_failed_lane_stalled",
        attemptCount: 5,
      },
    ]);
    assert.deepEqual(
      dequeued,
      ["s1"],
      "an abandoned row leaves the queue, or the lane re-sends it forever"
    );
    assert.deepEqual(
      cleared,
      ["s1"],
      "the per-class state is cleared, so a recovery starts a fresh run rather than an expired one"
    );
    assert.equal(warnings.length, 1, "the abandonment is reported once");
  }, NOW_MS);
});

test("ISS-9418: the session lane stamps the LANE give-up alongside — never instead of — the per-row dead-letter", async () => {
  // The per-lane half of the acceptance criterion. The row dead-letter is what
  // RELEASES the watermark (a deferred row pins the cursor; only a RECORDED
  // dead-letter may advance past it), so replacing it with the lane stamp would
  // stop this lane making progress for the whole outage. Both must be present,
  // and both are asserted here so removing either one reds this case.
  await runWithMockedNow(async ({ advance }) => {
    const { deps, deadLettered, dequeued, giveUpStamps } = makeRecordingDeps();
    const attemptsById = new Map<string, number>();
    const stalledSinceMsById = new Map<string, number>();

    await foldOnce(deps, attemptsById, stalledSinceMsById, ["s1", "s2"]);
    assert.deepEqual(
      giveUpStamps,
      [],
      "a lane merely deferring has not given up on anything"
    );

    advance(SESSION_LANE_STALL_CEILING_MS);
    await foldOnce(deps, attemptsById, stalledSinceMsById, ["s1", "s2"]);

    assert.deepEqual(
      deadLettered.map((call) => [call.id, call.recoverable]),
      [
        ["s1", true],
        ["s2", true],
      ],
      "the recoverable per-row dead-letter is unchanged"
    );
    assert.deepEqual(
      dequeued,
      ["s1", "s2"],
      "and still dequeues, which is what lets the watermark advance past them"
    );
    assert.deepEqual(
      giveUpStamps,
      [
        {
          gaveUpAtMs: NOW_MS + SESSION_LANE_STALL_CEILING_MS,
          // PLN-2028 (ISS-9963): the CAUSE rides with the stamp, so the process
          // that resumes this give-up announces what the lane kept failing on
          // rather than an instant and no reason.
          reason: SyncReason.IngestionFailed,
        },
      ],
      "the LANE give-up is stamped ONCE for the fold, not once per abandoned id"
    );
  }, NOW_MS);
});

test("ISS-7730: one id past the ceiling dead-letters without taking its still-fresh siblings with it", async () => {
  await runWithMockedNow(async () => {
    const { deps, deadLettered, dequeued, stallWrites } = makeRecordingDeps();
    const attemptsById = new Map<string, number>();
    // `stale` has been stalled a full ceiling already; `fresh` has never failed.
    const stalledSinceMsById = new Map<string, number>([
      ["stale", NOW_MS - SESSION_LANE_STALL_CEILING_MS],
    ]);

    await foldOnce(deps, attemptsById, stalledSinceMsById, ["stale", "fresh"]);

    assert.deepEqual(
      deadLettered.map((call) => call.id),
      ["stale"],
      "the ceiling is per row, not per batch — a healthy sibling must not be abandoned with it"
    );
    assert.deepEqual(dequeued, ["stale"]);
    assert.deepEqual(
      stallWrites.map((write) => write.id),
      ["fresh"],
      "the sibling defers and starts its own clock"
    );
    assert.equal(
      stallWrites[0].laneStalledSince,
      new Date(NOW_MS).toISOString()
    );
    assert.equal(
      stallWrites[0].nextAttemptAtMs,
      NOW_MS + SESSION_LANE_STALL_RETRY_MS,
      "the deferred sibling opens its run on the class floor (ISS-8610: the first defer of a run is still the floor)"
    );
  }, NOW_MS);
});

test("ISS-7730: the session and transcript lanes agree on when to give up", () => {
  // Two lanes measuring the SAME cloud outage must not give up at different
  // points. The constants are declared per lane (each lane owns its own policy
  // module and neither should import the other's), so the agreement the doc
  // comments assert is pinned here instead of left to prose — tuning one during
  // an incident without the other now fails a test rather than drifting silently.
  assert.equal(
    SESSION_LANE_STALL_CEILING_MS,
    TRANSCRIPT_LANE_STALL_CEILING_MS,
    "the wall-clock ceiling is one policy, declared twice"
  );
  // ISS-8689 narrowed what this second assertion claims. The transcript lane
  // now STAGES up to an hour off its stall clock, so the two lanes no longer
  // share a whole schedule — what they share is where a stall run OPENS. The
  // constant is unchanged and the equality still means something real; only the
  // word "flat" stopped being true of the transcript side.
  assert.equal(
    SESSION_LANE_STALL_RETRY_MS,
    TRANSCRIPT_LANE_STALL_RETRY_MS,
    "the delay a lane-stall run OPENS on is one policy, declared twice"
  );
});

test("ISS-7730: a mixed batch clears the stall run only for the ids that had one", () => {
  // `noteLaneAnswered` filters to ids that actually held a clock before issuing
  // the durable clear, so the healthy path costs no writes. Every other test
  // drives a single-id batch, which cannot tell that filter from its inverse —
  // and the inverse (durably clearing only the UN-stalled ids) is a real bug.
  const stalledSinceMsById = new Map<string, number>([
    ["was-stalled", NOW_MS - 1000],
  ]);
  const cleared: string[][] = [];
  const runners = createSessionFoldRunners({
    ...foldRunnerViewStub(),
    laneStalledSinceMsById: stalledSinceMsById,
    clearOutboxLaneStall: (ids) => cleared.push(ids),
  });

  runners.noteLaneAnswered(["never-stalled", "was-stalled"]);

  assert.deepEqual(
    cleared,
    [["was-stalled"]],
    "only the id that held a run is durably cleared"
  );
  assert.equal(
    stalledSinceMsById.has("was-stalled"),
    false,
    "and its in-memory run ends too — the two halves are one fact"
  );
});

test("ISS-7730: an ack_omitted defer ends the stall run in memory as well as on disk", () => {
  // `ack_omitted` is row-attributable and reaches the durable clear through the
  // BOUNDED fold's outbox write rather than through `noteLaneAnswered`. When the
  // in-memory delete did not ride that same write, the column said "not stalled"
  // while the live run kept accruing — and `stallWindowFor` reads the map, so a
  // row answered by an accepted ack could still be abandoned as lane-stalled.
  const stalledSinceMsById = new Map<string, number>([["omitted", NOW_MS]]);
  const writes: Array<string | null> = [];
  const runners = createSessionFoldRunners({
    ...foldRunnerViewStub(),
    laneStalledSinceMsById: stalledSinceMsById,
    recordOutboxRetry: (_id, _attempts, _next, _reason, stalledSince) =>
      writes.push(stalledSince),
  });

  runners.applyBoundedFold({
    ids: ["omitted"],
    syncMode: AgentSessionSyncMode.Backfill,
    payloadBytes: 10,
    counter: new Map<string, number>(),
    maxConsecutive: 5,
    reason: SyncReason.AckOmitted,
    recoverable: true,
    backoffMs: 30_000,
    recordOutboxOnDefer: true,
  });

  assert.deepEqual(
    writes,
    [null],
    "the column half of the clear still happens"
  );
  assert.equal(
    stalledSinceMsById.has("omitted"),
    false,
    "and the map half — the one the ceiling is actually measured from"
  );
});

test("ISS-7730: a broad outage cannot grow the stall-clock map past its cap", async () => {
  // `main/sync/AGENTS.md` invariant 10. The map is keyed by EXTERNAL session id
  // and, during a lane-wide outage, nothing removes an entry — no ack, no
  // row-attributable verdict — so every distinct session the drain reaches would
  // otherwise be retained until the 24h ceiling. The cap gates ADMISSION: a row
  // arriving at a saturated map defers with its budgets intact and writes NO
  // stall stamp, rather than having one invented for it.
  await runWithMockedNow(async () => {
    const { deps, deadLettered, stallWrites, warnings } = makeRecordingDeps();
    const attemptsById = new Map<string, number>();
    const stalledSinceMsById = new Map<string, number>();

    const overflow = 250;
    const total = MAX_TRACKED_LANE_STALLS + overflow;
    for (let start = 0; start < total; start += 50) {
      const batch: string[] = [];
      for (let offset = 0; offset < 50; offset += 1) {
        batch.push(`s${start + offset}`);
      }
      await foldOnce(deps, attemptsById, stalledSinceMsById, batch);
    }

    assert.equal(
      stalledSinceMsById.size,
      MAX_TRACKED_LANE_STALLS,
      "the map stops at the cap instead of tracking the whole local corpus"
    );
    assert.equal(
      stallWrites.length,
      MAX_TRACKED_LANE_STALLS,
      "an untracked row writes no stall stamp — a start this fold never observed must not reach the column"
    );
    assert.equal(
      attemptsById.size,
      total,
      "every id still defers and still tallies its attempt; the cap bounds the CLOCK, not the retry"
    );
    assert.equal(
      deadLettered.length,
      0,
      "and nothing is abandoned to make room"
    );
    assert.equal(
      warnings.length,
      overflow / 50,
      "each saturated batch says so once, so the cap is not a silent degradation"
    );
  }, NOW_MS);
});

test("ISS-7730: saturating the cap never restarts a clock a stalled session already holds", async () => {
  // The failure this whole ticket exists to prevent, in its cap-shaped form. An
  // eviction policy that made room by dropping a TRACKED run would hand that
  // session a fresh 24 hours every time the map filled, so the ceiling would
  // never be crossed and the lane-wide class would retry forever — invariant 5,
  // reintroduced by the fix for invariant 10.
  await runWithMockedNow(async ({ advance }) => {
    const { deps, deadLettered, stallWrites } = makeRecordingDeps();
    const attemptsById = new Map<string, number>();
    const stalledSinceMsById = new Map<string, number>();

    // A single session starts its run, alone in the map.
    await foldOnce(deps, attemptsById, stalledSinceMsById, ["live"]);
    assert.equal(stallWrites.at(0)?.laneStalledSince, ORIGIN_ISO);

    // The outage then floods the lane with enough distinct sessions to saturate
    // the cap several times over, spread across the whole ceiling window.
    const floodBatches = 30;
    for (let batch = 0; batch < floodBatches; batch += 1) {
      const ids: string[] = [];
      for (let offset = 0; offset < 400; offset += 1) {
        ids.push(`flood-${batch}-${offset}`);
      }
      await foldOnce(deps, attemptsById, stalledSinceMsById, ids);
      advance(SESSION_LANE_STALL_CEILING_MS / floodBatches);
    }

    assert.equal(
      stalledSinceMsById.get("live"),
      NOW_MS,
      "the live run still starts where it started — the flood evicted nothing"
    );

    await foldOnce(deps, attemptsById, stalledSinceMsById, ["live"]);
    assert.deepEqual(
      deadLettered.map((call) => call.id),
      ["live"],
      "so the ceiling is still reached, on the original clock, after a full-cap outage"
    );
    assert.equal(
      deadLettered[0].reason,
      "ingestion_failed_lane_stalled",
      "and it terminates as a lane stall, not as an exhausted budget"
    );
  }, NOW_MS);
});

test("ISS-7985: the in-memory nextRetryAfterMs deadline is armed and pickReadyCandidates respects it", async () => {
  await runWithMockedNow(async ({ advance }) => {
    const { deps } = makeRecordingDeps();
    const attemptsById = new Map<string, number>();
    const stalledSinceMsById = new Map<string, number>();

    await foldOnce(deps, attemptsById, stalledSinceMsById, ["s1"]);

    const deadline = deps.nextRetryAfterMs.get("s1");
    assert.equal(
      deadline,
      NOW_MS + SESSION_LANE_STALL_RETRY_MS,
      "the fold opens a fresh run on the class floor and writes it into the in-memory map"
    );

    const beforeDeadline = pickReadyCandidates({
      queue: ["s1"],
      limit: 10,
      nextRetryAfterMs: deps.nextRetryAfterMs,
      nowMs: NOW_MS + SESSION_LANE_STALL_RETRY_MS - 1,
    });
    assert.deepEqual(
      beforeDeadline,
      [],
      "pickReadyCandidates excludes the id while the deadline is in the future"
    );

    const atDeadline = pickReadyCandidates({
      queue: ["s1"],
      limit: 10,
      nextRetryAfterMs: deps.nextRetryAfterMs,
      nowMs: NOW_MS + SESSION_LANE_STALL_RETRY_MS,
    });
    assert.deepEqual(
      atDeadline,
      ["s1"],
      "pickReadyCandidates includes the id once the deadline passes"
    );

    advance(SESSION_LANE_STALL_RETRY_MS + 1);
    await foldOnce(deps, attemptsById, stalledSinceMsById, ["s1"]);
    const secondDeadline = deps.nextRetryAfterMs.get("s1");
    // ISS-8610 CHANGED THIS EXPECTATION, deliberately. The delay used to be the
    // flat `SESSION_LANE_STALL_RETRY_MS` on every defer; it is now read off the
    // run's own age, so a second defer one floor into the run lands on the
    // SECOND rung — 2x the floor. The re-arm-from-the-current-clock property the
    // case was written for is unchanged and is still what is asserted.
    assert.equal(
      secondDeadline,
      NOW_MS +
        SESSION_LANE_STALL_RETRY_MS +
        1 +
        2 * SESSION_LANE_STALL_RETRY_MS,
      "a second deferral re-arms the deadline from the current clock, on the rung the run has earned"
    );
  }, NOW_MS);
});

// ---------------------------------------------------------------------------
// ISS-8605 (PRD-699 F1/F2) + ISS-8595: the fold stopped being the
// `ingestion_failed` fold and became the ENVIRONMENTAL fold. Three more classes
// share its clock and its ceiling while keeping their own durable spellings and
// their own retry window.
// ---------------------------------------------------------------------------

/**
 * The durable strings each class writes, spelled out here rather than read from
 * `SESSION_ENVIRONMENTAL_DEFER_POLICY`. These land in a persisted `last_error`
 * that `retryCounterMapForReason` later switches on and that an operator reads
 * during an incident, so they are a contract; deriving the expectation from the
 * table under test would agree with any renaming of it, including a wrong one.
 */
const EXPECTED_ENVIRONMENTAL_SPELLINGS = [
  {
    deferClass: SessionEnvironmentalDeferClass.IngestionFailed,
    retryReason: "ingestion_failed",
    deadLetterReason: "ingestion_failed_lane_stalled",
    floorMs: 5 * 60 * 1000,
  },
  {
    deferClass: SessionEnvironmentalDeferClass.RateLimited,
    retryReason: "rate_limited",
    deadLetterReason: "rate_limited_lane_stalled",
    floorMs: 30_000,
  },
  {
    deferClass: SessionEnvironmentalDeferClass.AckTimeout,
    retryReason: "ack_timeout",
    deadLetterReason: "ack_timeout_lane_stalled",
    floorMs: 30_000,
  },
  {
    deferClass: SessionEnvironmentalDeferClass.UnknownAckReason,
    retryReason: "unknown_ack_reason",
    deadLetterReason: "unknown_ack_reason_lane_stalled",
    floorMs: 30_000,
  },
] as const;

test("ISS-8605: every environmental class defers on its own window and records its own reason", async () => {
  for (const expected of EXPECTED_ENVIRONMENTAL_SPELLINGS) {
    await runWithMockedNow(async () => {
      const { deps, deadLettered, stallWrites } = makeRecordingDeps();
      const attemptsById = new Map<string, number>();
      const stalledSinceMsById = new Map<string, number>();

      // Twelve consecutive rejections — well past the retired per-row caps of 3
      // (ack_timeout) and 5 (rate_limited) this ticket deleted.
      for (let round = 0; round < 12; round += 1) {
        await foldOnce(
          deps,
          attemptsById,
          stalledSinceMsById,
          ["s1"],
          expected.deferClass
        );
      }

      assert.equal(
        deadLettered.length,
        0,
        `sustained ${expected.retryReason} must never dead-letter a row inside the ceiling`
      );
      assert.equal(
        attemptsById.get("s1"),
        12,
        `${expected.retryReason} still tallies attempts as evidence`
      );
      assert.equal(
        stallWrites.at(-1)?.reason,
        expected.retryReason,
        `${expected.retryReason} records its own durable last_error`
      );
      // The clock never advances in this loop, so all twelve defers sit at the
      // run's opening instant and every one of them is the FLOOR rung. That is
      // what makes this an assertion about the class's floor rather than about
      // the ladder, which the ISS-8610 cases below cover separately.
      assert.equal(
        deps.nextRetryAfterMs.get("s1"),
        NOW_MS + expected.floorMs,
        `${expected.retryReason} opens its run on its own floor`
      );
    }, NOW_MS);
  }
});

test("ISS-8605: every environmental class still reaches the shared 24h terminal path", async () => {
  for (const expected of EXPECTED_ENVIRONMENTAL_SPELLINGS) {
    await runWithMockedNow(async ({ advance }) => {
      const { deps, deadLettered, dequeued } = makeRecordingDeps();
      const attemptsById = new Map<string, number>();
      const stalledSinceMsById = new Map<string, number>();

      await foldOnce(
        deps,
        attemptsById,
        stalledSinceMsById,
        ["s1"],
        expected.deferClass
      );
      advance(SESSION_LANE_STALL_CEILING_MS);
      await foldOnce(
        deps,
        attemptsById,
        stalledSinceMsById,
        ["s1"],
        expected.deferClass
      );

      assert.deepEqual(
        deadLettered,
        [
          {
            id: "s1",
            // RECOVERABLE, never terminal: a day of a broken world is not
            // evidence against these bytes, so the FEA-3363 revisit re-drives it.
            recoverable: true,
            reason: expected.deadLetterReason,
            attemptCount: 2,
          },
        ],
        `${expected.retryReason} terminates as its own lane stall`
      );
      assert.deepEqual(dequeued, ["s1"]);
    }, NOW_MS);
  }
});

test("ISS-8605: a row bouncing between environmental reasons keeps ONE clock", async () => {
  // The negative half of the ceiling test above, and the failure mode that would
  // make the bound unreachable in production: an outage that alternates 429 and
  // 500 must not restart the row's stall clock on every change of reason, or the
  // 24h ceiling is never crossed and the class retries forever (invariant 5).
  await runWithMockedNow(async ({ advance }) => {
    const { deps, deadLettered } = makeRecordingDeps();
    const attemptsById = new Map<string, number>();
    const stalledSinceMsById = new Map<string, number>();

    await foldOnce(
      deps,
      attemptsById,
      stalledSinceMsById,
      ["s1"],
      SessionEnvironmentalDeferClass.RateLimited
    );
    const openedAtMs = stalledSinceMsById.get("s1");

    advance(SESSION_LANE_STALL_CEILING_MS / 2);
    await foldOnce(
      deps,
      attemptsById,
      stalledSinceMsById,
      ["s1"],
      SessionEnvironmentalDeferClass.IngestionFailed
    );
    assert.equal(
      stalledSinceMsById.get("s1"),
      openedAtMs,
      "changing reason mid-outage must not re-open the run"
    );
    assert.equal(
      deadLettered.length,
      0,
      "and halfway through the window nothing is abandoned yet"
    );

    advance(SESSION_LANE_STALL_CEILING_MS / 2);
    await foldOnce(
      deps,
      attemptsById,
      stalledSinceMsById,
      ["s1"],
      SessionEnvironmentalDeferClass.AckTimeout
    );
    assert.deepEqual(
      deadLettered.map((call) => call.id),
      ["s1"],
      "so the ceiling is reached on the ORIGINAL clock, whichever reason is current when it expires"
    );
  }, NOW_MS);
});

test("ISS-8605: the policy table covers every declared environmental class", () => {
  // A class added to `SessionEnvironmentalDeferClass` without an entry here
  // would already fail `tsc` on the Record. What this pins is the other
  // direction: that the four classes the suite above enumerates ARE the four the
  // module declares, so adding a fifth cannot slip through with no behavioural
  // coverage at all.
  assert.deepEqual(
    Object.values(SessionEnvironmentalDeferClass).toSorted(),
    EXPECTED_ENVIRONMENTAL_SPELLINGS.map(
      (expected) => expected.deferClass
    ).toSorted(),
    "every declared environmental class is exercised above"
  );
  assert.equal(
    Object.keys(SESSION_ENVIRONMENTAL_DEFER_POLICY).length,
    EXPECTED_ENVIRONMENTAL_SPELLINGS.length
  );
});

test("ISS-8605: each environmental class advances its OWN tally, never a sibling's", async () => {
  // `environmentalTallyFor` is the only thing standing between four classes and
  // one shared counter. A shared counter would still defer correctly and still
  // reach the ceiling, so every other test here would stay green while the
  // ISS-7248 diagnostic reported an attempt number the current failure did not
  // cause, and a resume seeded the wrong class's tally from the outbox.
  const view = foldRunnerViewStub();
  const runners = createSessionFoldRunners(view);
  const tallies = {
    [SessionEnvironmentalDeferClass.IngestionFailed]:
      view.ingestionFailedCountById,
    [SessionEnvironmentalDeferClass.RateLimited]: view.rateLimitedCountById,
    [SessionEnvironmentalDeferClass.AckTimeout]: view.timeoutCountById,
    [SessionEnvironmentalDeferClass.UnknownAckReason]:
      view.unknownAckReasonCountById,
  };

  for (const [deferClass, expectedTally] of Object.entries(tallies)) {
    for (const map of Object.values(tallies)) {
      map.clear();
    }
    await runners.applyLaneStall({
      ids: ["s1"],
      syncMode: AgentSessionSyncMode.Backfill,
      payloadBytes: 100,
      deferClass: deferClass as SessionEnvironmentalDeferClass,
    });
    assert.equal(
      expectedTally.get("s1"),
      1,
      `${deferClass} advances its own tally`
    );
    // The positive assertion above is worth nothing without this: it would hold
    // just as well if the fold wrote to every map at once.
    for (const [otherClass, otherTally] of Object.entries(tallies)) {
      if (otherClass === deferClass) {
        continue;
      }
      assert.equal(
        otherTally.size,
        0,
        `${deferClass} leaves ${otherClass}'s tally untouched`
      );
    }
  }
});

/**
 * ISS-8605 (whitlockk review) — the durability half of the wall-clock bound.
 *
 * Every other test in this file proves the CLOCK is right. These two prove it
 * survives, which is a different claim and the one the fold's terminal path
 * actually depends on: `loadPendingSessionOutboxEngineState` selects on
 * `attempt_count > 0`, so a row whose durable write never committed is invisible
 * to the resume and the next launch stamps a NEW start. A desktop restarting
 * inside an outage would then cycle forever — an unbounded stall that reads, on
 * every screen, as a healthy backoff. Both cases fail against a fire-and-forget
 * write, and neither is reachable from a happy-path assertion.
 */
test("ISS-8605: the fold does not settle until the durable stall clock has committed", async () => {
  await runWithMockedNow(async () => {
    const { deps, stallWrites, committedStallWrites } = makeRecordingDeps();

    await foldOnce(deps, new Map(), new Map(), ["s1"]);

    assert.equal(stallWrites.length, 1, "the defer issued its durable write");
    assert.deepEqual(
      committedStallWrites.map((write) => write.id),
      ["s1"],
      "and the fold waited for it to COMMIT — a write nobody awaited is a bound nobody has"
    );
  }, NOW_MS);
});

test("ISS-8605: a refused stall write is re-issued with the ORIGINAL first-stall anchor", async () => {
  await runWithMockedNow(async () => {
    const { deps, stallWrites, committedStallWrites, warnings } =
      makeRecordingDeps({ refuseFirst: true });

    await foldOnce(deps, new Map(), new Map(), ["s1"]);

    assert.equal(
      stallWrites.length,
      2,
      "a refused write is retried inside the same fold, not left for a later pass that may never come"
    );
    assert.deepEqual(
      stallWrites.map((write) => write.laneStalledSince),
      [ORIGIN_ISO, ORIGIN_ISO],
      "and the re-attempt carries the run's START — restamping it would hand the row a fresh 24h on every db hiccup"
    );
    assert.deepEqual(
      committedStallWrites.map((write) => write.laneStalledSince),
      [ORIGIN_ISO],
      "so what actually lands on disk is the first-stall time, not the retry's"
    );
    assert.deepEqual(warnings, [], "a write that recovered is not an alarm");
  }, NOW_MS);
});

test("ISS-8605: a stall clock that never commits is reported, not silently in-memory", async () => {
  await runWithMockedNow(async () => {
    const { deps, stallWrites, committedStallWrites, warnings } =
      makeRecordingDeps({ refuseAll: true });

    await foldOnce(deps, new Map(), new Map(), ["s1"]);

    assert.equal(stallWrites.length, 2, "attempted, then re-attempted");
    assert.deepEqual(committedStallWrites, [], "and neither landed");
    assert.equal(
      warnings.length,
      1,
      "the row's ceiling is now in-memory only, which is exactly the state an operator must be told about"
    );
    assert.ok(
      warnings[0].includes("s1"),
      "and the report names the session whose bound is not durable"
    );
  }, NOW_MS);
});

// ---------------------------------------------------------------------------
// ISS-8610 (PRD-699 F8): the four clocked classes stopped polling flat. Each
// stages off the run the row is already in, from its own floor to the shared
// one-hour per-delay cap, and no defer is ever scheduled past the 24h ceiling.
// ---------------------------------------------------------------------------

/**
 * Fold `rounds` consecutive rejections for one id, advancing the virtual clock
 * by exactly the delay each fold chose, and return those delays in order.
 *
 * Advancing by the CHOSEN delay is the point: it walks the run the way the lane
 * actually walks it (the next attempt happens when the lane said it would), so
 * the sequence is the ladder a real outage climbs rather than one a fixed
 * advance happens to sample.
 */
async function walkStagedDelaysMs(
  deferClass: SessionEnvironmentalDeferClass,
  rounds: number,
  advance: (ms: number) => void
): Promise<number[]> {
  const { deps } = makeRecordingDeps();
  const attemptsById = new Map<string, number>();
  const stalledSinceMsById = new Map<string, number>();
  const delaysMs: number[] = [];
  let nowMs = NOW_MS;
  for (let round = 0; round < rounds; round += 1) {
    await foldOnce(deps, attemptsById, stalledSinceMsById, ["s1"], deferClass);
    const deadline = deps.nextRetryAfterMs.get("s1") ?? nowMs;
    const delayMs = deadline - nowMs;
    delaysMs.push(delayMs);
    advance(delayMs);
    nowMs += delayMs;
  }
  return delaysMs;
}

test("ISS-8610: a sustained ingestion_failed run stages 5 -> 10 -> 20 -> 40 -> 60 -> 60 minutes", async () => {
  await runWithMockedNow(async ({ advance }) => {
    const delaysMs = await walkStagedDelaysMs(
      SessionEnvironmentalDeferClass.IngestionFailed,
      6,
      advance
    );

    assert.deepEqual(
      delaysMs.map((delayMs) => delayMs / 60_000),
      [5, 10, 20, 40, 60, 60],
      "the run doubles from its own floor and pins at the shared one-hour per-delay cap"
    );
  }, NOW_MS);
});

test("ISS-8610: the three 30s classes stage from their own floor to the same one-hour cap", async () => {
  for (const deferClass of [
    SessionEnvironmentalDeferClass.RateLimited,
    SessionEnvironmentalDeferClass.AckTimeout,
    SessionEnvironmentalDeferClass.UnknownAckReason,
  ]) {
    await runWithMockedNow(async ({ advance }) => {
      const delaysMs = await walkStagedDelaysMs(deferClass, 8, advance);

      assert.deepEqual(
        delaysMs,
        [
          RATE_LIMIT_BACKOFF_MS,
          2 * RATE_LIMIT_BACKOFF_MS,
          4 * RATE_LIMIT_BACKOFF_MS,
          8 * RATE_LIMIT_BACKOFF_MS,
          16 * RATE_LIMIT_BACKOFF_MS,
          32 * RATE_LIMIT_BACKOFF_MS,
          64 * RATE_LIMIT_BACKOFF_MS,
          LANE_STALL_MAX_RETRY_MS,
        ],
        `${deferClass} keeps its own 30s floor and reaches the shared cap`
      );
    }, NOW_MS);
  }
});

test("ISS-8610: a run rehydrated from a 3-hour-old lane_stalled_since schedules off THAT age, not the floor", async () => {
  await runWithMockedNow(async () => {
    const { deps, stallWrites, infos } = makeRecordingDeps();
    const attemptsById = new Map<string, number>();
    // The resume case, and the reason the durable column exists: the previous
    // process recorded this run three hours ago and `loadPendingSessionOutboxEngineState`
    // handed it back.
    const resumedStartMs = NOW_MS - 3 * 60 * 60_000;
    const stalledSinceMsById = new Map<string, number>([
      ["s1", resumedStartMs],
    ]);

    await foldOnce(deps, attemptsById, stalledSinceMsById, ["s1"]);

    const delayMs = (deps.nextRetryAfterMs.get("s1") ?? 0) - NOW_MS;
    assert.equal(
      delayMs,
      LANE_STALL_MAX_RETRY_MS,
      "a three-hour-old run is far past the last rung, so it resumes at the cap"
    );
    assert.notEqual(
      delayMs,
      SESSION_LANE_STALL_RETRY_MS,
      "restarting a resumed run at the floor is the defect this reads off the column to avoid"
    );
    assert.equal(
      stallWrites[0].laneStalledSince,
      new Date(resumedStartMs).toISOString(),
      "and the run's original start is what stays on the column"
    );
    assert.ok(
      infos.some((message) =>
        message.includes("deferring 1 session(s) for 3600s")
      ),
      "the deferral log states the wait the lane is actually taking, not a policy constant"
    );
  }, NOW_MS);
});

test("ISS-8610: a defer issued inside the last rung never schedules past the 24h ceiling", async () => {
  await runWithMockedNow(async () => {
    const { deps, deadLettered, stallWrites } = makeRecordingDeps();
    // Two minutes of ceiling left, and a run old enough that the ladder alone
    // would ask for a full hour. Before ISS-8610 the flat five-minute defer
    // landed three minutes PAST the ceiling and the row dead-lettered late.
    const startedAtMs = NOW_MS - (SESSION_LANE_STALL_CEILING_MS - 2 * 60_000);
    const stalledSinceMsById = new Map<string, number>([["s1", startedAtMs]]);

    await foldOnce(deps, new Map(), stalledSinceMsById, ["s1"]);

    assert.deepEqual(deadLettered, [], "the row is still inside its ceiling");
    assert.equal(
      stallWrites[0].nextAttemptAtMs,
      startedAtMs + SESSION_LANE_STALL_CEILING_MS,
      "the delay is capped by what is left of the run, so the next attempt lands exactly ON the give-up instant and the terminal path stays reachable"
    );
  }, NOW_MS);
});

test("ISS-8610: a map-saturated row still gets its class floor and still writes nothing durable", async () => {
  await runWithMockedNow(async () => {
    const { deps, stallWrites, warnings } = makeRecordingDeps();
    // Saturate the admission cap directly rather than folding 10,000 ids: the
    // fold reads this map's SIZE, so a pre-filled map is the same input.
    const stalledSinceMsById = new Map<string, number>();
    for (let index = 0; index < MAX_TRACKED_LANE_STALLS; index += 1) {
      stalledSinceMsById.set(`tracked-${index}`, NOW_MS);
    }

    await foldOnce(deps, new Map(), stalledSinceMsById, ["untracked"]);

    assert.equal(
      deps.nextRetryAfterMs.get("untracked"),
      NOW_MS + SESSION_LANE_STALL_RETRY_MS,
      "an untracked row has no run to read a rung off, so it gets the class floor"
    );
    assert.deepEqual(
      stallWrites,
      [],
      "and still writes no durable stamp — a start this fold never observed must not reach the column"
    );
    assert.equal(
      warnings.length,
      1,
      "the cap is still not a silent degradation"
    );
  }, NOW_MS);
});
