/**
 * @file agent-session-sync-lane-stall-retry-after.test.ts
 * @description ISS-10014: the session lane honors a server `Retry-After`.
 *
 * PRD-699 Appendix A requires every ENVIRONMENTAL defer to honor `Retry-After`;
 * four of the five lanes did, and this one could not, because the sync route
 * emitted no such header and the ack union had no field to carry one. This suite
 * covers the consuming half — the fold reading a hint off its config and pacing
 * the row by it.
 *
 * A sibling file rather than more cases in
 * `agent-session-sync-lane-stall-fold.test.ts`: that file is already at 944
 * lines against the repo's 1,000-line ceiling.
 *
 * Every case drives the REAL fold through the shared fixtures and reads the
 * scheduled instant back off `nextRetryAfterMs`. The two "at least 600s" cases
 * are the causal ones: each reaches a different `laneStallDelayMs` call site
 * (the tracked clock and the admission-capped one), and deleting the hint from
 * that site reddens it. The absent-hint and ceiling cases are green with or
 * without the hand-off by design — they pin that the hint changes nothing where
 * it must not. Asserting the arithmetic of `laneStallDelayMs` directly would
 * leave the wiring unpinned — the defect
 * `desktop-transcripts-client-retry-after.test.ts` records for the other lane.
 */

import assert from "node:assert/strict";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import {
  MAX_TRACKED_LANE_STALLS,
  RATE_LIMIT_BACKOFF_MS,
  SESSION_LANE_STALL_CEILING_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { createSessionFoldRunners } from "../src/main/agent-sync/agent-session-sync-fold-runners.js";
import { SessionEnvironmentalDeferClass } from "../src/main/agent-sync/agent-session-sync-lane-stall-fold.js";
import { LANE_STALL_MAX_RETRY_MS } from "../src/shared/lane-stall-clock.js";
import {
  foldOnce,
  foldRunnerViewStub,
  makeRecordingDeps,
  NOW_MS,
} from "./agent-session-sync-lane-stall-fixtures.js";
import { runWithMockedNow } from "./agent-session-sync-service-fixtures.js";

/** The ticket's worked example: `Retry-After: 600` on a coded 429. */
const SERVER_HINT_MS = 600_000;

/**
 * The wait the 429 class would choose on its own for a freshly-opened run:
 * `SESSION_ENVIRONMENTAL_FLOOR_SCHEDULE.floorMs`, which IS this constant.
 */
const OWN_OPENING_CHOICE_MS = RATE_LIMIT_BACKOFF_MS;

/**
 * `runWithMockedNow` defaults its ORIGIN to the real clock, so every case here
 * has to pin it to the fixtures' `NOW_MS` — the hand-written expected instants
 * below are only meaningful against that origin.
 */
function atOrigin(body: () => Promise<void>): Promise<void> {
  return runWithMockedNow(body, NOW_MS);
}

function scheduledDelayMs(deps: { nextRetryAfterMs: Map<string, number> }) {
  return (deps.nextRetryAfterMs.get("s1") ?? 0) - NOW_MS;
}

test("ISS-10014 AC1: a 600s hint makes the lane wait at least that long where its own schedule chose less", async () => {
  await atOrigin(async () => {
    const { deps } = makeRecordingDeps();

    await foldOnce(
      deps,
      new Map<string, number>(),
      new Map<string, number>(),
      ["s1"],
      SessionEnvironmentalDeferClass.RateLimited,
      SERVER_HINT_MS
    );

    assert.equal(
      scheduledDelayMs(deps),
      SERVER_HINT_MS,
      "the server asked for 600s and the lane's own opening rung is 30s, so the server's minimum is what gets scheduled"
    );
    assert.notEqual(
      scheduledDelayMs(deps),
      OWN_OPENING_CHOICE_MS,
      "scheduling the lane's own 30s against an explicit 600s is the defect this ticket exists to fix — it retries into the window the server just refused"
    );
  });
});

test("ISS-10014 AC1: the hint is honored on the admission-capped path too, where the fold has no clock for the row", async () => {
  await atOrigin(async () => {
    const { deps } = makeRecordingDeps();
    // Saturate the cap directly, as the sibling suite does: the fold reads this
    // map's SIZE, so a pre-filled map is the same input as folding that many ids.
    const stalledSinceMsById = new Map<string, number>();
    for (let index = 0; index < MAX_TRACKED_LANE_STALLS; index += 1) {
      stalledSinceMsById.set(`tracked-${index}`, NOW_MS);
    }

    await foldOnce(
      deps,
      new Map<string, number>(),
      stalledSinceMsById,
      ["s1"],
      SessionEnvironmentalDeferClass.RateLimited,
      SERVER_HINT_MS
    );

    assert.equal(
      scheduledDelayMs(deps),
      SERVER_HINT_MS,
      "an untracked row opens at the class floor, and the server's 600s is a minimum over that floor exactly as it is over a tracked rung — this is the second call site, and a hint dropped only here would leave the ceiling-saturated case retrying into the refused window"
    );
  });
});

test("ISS-10014 AC2: an absent hint changes nothing about the staged ladder", async () => {
  await atOrigin(async () => {
    const { deps } = makeRecordingDeps();

    // No hint argument at all — the shape an older cloud, or any cloud that
    // simply did not send the header, actually produces.
    await foldOnce(
      deps,
      new Map<string, number>(),
      new Map<string, number>(),
      ["s1"],
      SessionEnvironmentalDeferClass.RateLimited
    );

    assert.equal(
      scheduledDelayMs(deps),
      OWN_OPENING_CHOICE_MS,
      "an absent hint leaves the class's own opening rung exactly as it was — the cross-repo requirement that no behavior may depend on the field"
    );
  });
});

test("ISS-10014: a hint SHORTER than the earned rung never drags the ladder back down", async () => {
  await atOrigin(async () => {
    const { deps } = makeRecordingDeps();
    // A run opened three hours ago is far past the last rung, so the schedule
    // has earned the per-delay cap.
    const resumedStartMs = NOW_MS - 3 * 60 * 60_000;

    await foldOnce(
      deps,
      new Map<string, number>(),
      new Map<string, number>([["s1", resumedStartMs]]),
      ["s1"],
      SessionEnvironmentalDeferClass.RateLimited,
      60_000
    );

    assert.equal(
      scheduledDelayMs(deps),
      LANE_STALL_MAX_RETRY_MS,
      "`Retry-After` is a MINIMUM wait, so a 60s hint against an earned 1h rung is honored by waiting the hour"
    );
    assert.notEqual(
      scheduledDelayMs(deps),
      60_000,
      "taking the hint as a MAXIMUM would let a transient short hint pin a day-long outage to its opening rung and defeat the staging entirely (PRD-699 F8)"
    );
  });
});

test("ISS-10014 AC3: a hint longer than the remaining wall clock cannot push the next attempt past the 24h ceiling", async () => {
  await atOrigin(async () => {
    const { deps } = makeRecordingDeps();
    const remainingMs = 10 * 60_000;
    const startedAtMs = NOW_MS - (SESSION_LANE_STALL_CEILING_MS - remainingMs);

    await foldOnce(
      deps,
      new Map<string, number>(),
      new Map<string, number>([["s1", startedAtMs]]),
      ["s1"],
      SessionEnvironmentalDeferClass.RateLimited,
      12 * 60 * 60_000
    );

    const nextAttemptAtMs = deps.nextRetryAfterMs.get("s1") ?? 0;
    assert.equal(
      nextAttemptAtMs - NOW_MS,
      remainingMs,
      "the hint is capped by what is left of the run, not honored in full"
    );
    assert.ok(
      nextAttemptAtMs <= startedAtMs + SESSION_LANE_STALL_CEILING_MS,
      "the ceiling is only evaluated when an attempt actually RUNS, so a hint scheduled past it would put the row's terminal path permanently out of reach — an invariant 5 violation wearing invariant 4's clothes"
    );
  });
});

test("ISS-10014 AC3: on the admission-capped path the hint is bounded by the run ceiling, exactly as a freshly-opened tracked run is", async () => {
  await atOrigin(async () => {
    const { deps } = makeRecordingDeps();
    const stalledSinceMsById = new Map<string, number>();
    for (let index = 0; index < MAX_TRACKED_LANE_STALLS; index += 1) {
      stalledSinceMsById.set(`tracked-${index}`, NOW_MS);
    }

    // Past the ceiling but inside what the parser admits (30 days).
    await foldOnce(
      deps,
      new Map<string, number>(),
      stalledSinceMsById,
      ["s1"],
      SessionEnvironmentalDeferClass.RateLimited,
      SESSION_LANE_STALL_CEILING_MS + 60 * 60_000
    );

    assert.equal(
      scheduledDelayMs(deps),
      SESSION_LANE_STALL_CEILING_MS,
      "an untracked row has no clock, so its window opens now and the whole ceiling is the bound — the same bound a tracked run that opened this instant gets"
    );
  });
});

test("ISS-10014: a hinted stall-fold rejection holds the WHOLE lane, not only the rejected rows", async () => {
  await runWithMockedNow(async ({ advance }) => {
    const view = foldRunnerViewStub();
    const runners = createSessionFoldRunners(view);
    assert.equal(runners.heldEnvironmentally(), false);

    await runners.applyLaneStall({
      ids: ["s1"],
      syncMode: AgentSessionSyncMode.Incremental,
      payloadBytes: 1024,
      deferClass: SessionEnvironmentalDeferClass.RateLimited,
      retryAfterMs: SERVER_HINT_MS,
    });

    // The fold paced s1; this is about every OTHER ready row. The 429 is keyed
    // per compute target, so the next 5s tick would otherwise fill the next
    // batch from rows the fold never saw and send it into the refused window.
    assert.equal(
      runners.heldEnvironmentally(),
      true,
      "the next tick is bounced for the whole lane"
    );
    advance(SERVER_HINT_MS - 1);
    assert.equal(runners.heldEnvironmentally(), true, "held to the last ms");
    advance(1);
    assert.equal(
      runners.heldEnvironmentally(),
      false,
      "and released exactly when the server's wait elapses"
    );
  }, NOW_MS);
});

test("ISS-10014 AC2: a stall-fold rejection WITHOUT a hint holds nothing lane-wide (the ISS-8605 shape)", async () => {
  await runWithMockedNow(async () => {
    const view = foldRunnerViewStub();
    const runners = createSessionFoldRunners(view);

    await runners.applyLaneStall({
      ids: ["s1"],
      syncMode: AgentSessionSyncMode.Incremental,
      payloadBytes: 1024,
      deferClass: SessionEnvironmentalDeferClass.RateLimited,
    });

    assert.equal(
      runners.heldEnvironmentally(),
      false,
      "an older cloud sends no header, and the lane keeps the per-row pacing it had"
    );
  }, NOW_MS);
});

test("ISS-10014: a Retry-After on the lane gate is honored past the gate's own floor", async () => {
  await runWithMockedNow(({ advance }) => {
    const view = foldRunnerViewStub();
    const runners = createSessionFoldRunners(view);
    const hintMs = 60 * 60_000;

    runners.deferLaneEnvironmental(["s1"], SyncReason.TargetNotOwned, hintMs);

    // The gate's own opening rung is the 5-minute floor; a 403 carrying an hour
    // must not be retried a dozen times into it.
    advance(LANE_STALL_MAX_RETRY_MS - 1);
    assert.equal(
      runners.heldEnvironmentally(),
      true,
      "still held well past the gate's own opening rung"
    );
    advance(1);
    assert.equal(
      runners.heldEnvironmentally(),
      false,
      "released when the server's hour elapses"
    );
    return Promise.resolve();
  }, NOW_MS);
});
