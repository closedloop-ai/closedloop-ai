/**
 * @file transcript-lane-recovery-door.test.ts
 * @description ISS-9884 (PLN-1986 §5, D-5): the transcript lane's recovery door.
 *
 * The merged "Transcript upload paused" copy promises "It resumes automatically
 * once that's restored." These cases are what make that sentence checkable: both
 * doors (an event, and the widening window with no event at all), the revival of
 * the rows the give-up paused — asserted by the revived transcript UPLOADING, not
 * by the stamp clearing, because a door that cleared the stamp and stranded every
 * paused row would pass the latter — and the bound that stops a revived row
 * buying a fresh run.
 */
import assert from "node:assert/strict";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { test } from "vitest";
import { buildTranscriptSyncSourceKey } from "../src/main/transcript-sync/transcript-lane-give-up.js";
import { kickTranscriptSweepAfterTierChange } from "../src/main/transcript-sync/transcript-sweep-kick.js";
import type { TranscriptSyncService } from "../src/main/transcript-sync/transcript-sync-service.js";
import { TRANSCRIPT_LANE_STALL_CEILING_MS } from "../src/main/transcript-sync/transcript-sync-types.js";
import { TranscriptSyncStatus } from "../src/shared/transcript-sync-status-contract.js";
import {
  CloudMode,
  COMPUTE_TARGET,
  type LaneHarness,
  MINUTE_MS,
  SKIP_PATH,
  START_MS,
  SYNC_PLAN_PATH,
  UPLOADED_OFFSET,
  withLaneHarness,
} from "./helpers/transcript-lane-give-up-harness.js";

const iso = (ms: number) => new Date(ms).toISOString();

const PAST_CEILING_MS = START_MS - TRANSCRIPT_LANE_STALL_CEILING_MS - MINUTE_MS;

test("ISS-9884 event door: a policy/tier kick re-arms a given-up lane, and its sweep uploads at once", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.Unauthorized;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    await lane.tickAt(START_MS);
    await lane.observeFresh("sess-b");

    lane.cloud.mode = CloudMode.Healthy;
    lane.clock.ms = START_MS + MINUTE_MS;
    const { service, sweeps } = captureSweeps(lane.service);
    kickTranscriptSweepAfterTierChange(service);
    await Promise.all(sweeps);

    assert.deepEqual(
      lane.planPostsFor("sess-b").map((post) => post.atMs),
      [START_MS + MINUTE_MS],
      "a minute into the give-up's five-minute window, so only the event can have opened it"
    );
    assert.deepEqual(
      await rowState(lane, "sess-b"),
      UPLOADED_ROW,
      "sess-b uploaded, settled, and no longer carries the reason it was paused for"
    );
    assert.equal(
      await lane.laneGaveUpAt(),
      null,
      "the upload was the lane answering, so the stamp is cleared"
    );
  });
});

test("ISS-9884 event door: an event that lands before a relaunched lane has read its give-up still re-arms it", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.Unauthorized;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    await lane.tickAt(START_MS);
    assert.equal(await lane.laneGaveUpAt(), iso(START_MS));

    // A new process, which has not read the durable stamp when the event fires.
    lane.relaunch();
    lane.clock.ms = START_MS + MINUTE_MS;
    await lane.observeFresh("sess-b");
    lane.cloud.mode = CloudMode.Healthy;
    lane.service.noteLaneRecoverySignal();
    await lane.tickAt(START_MS + MINUTE_MS);

    assert.deepEqual(
      lane.planPostsFor("sess-b").map((post) => post.atMs),
      [START_MS + MINUTE_MS],
      "a minute into the adopted give-up's five-minute window, so only the event can have opened it"
    );
    assert.deepEqual(
      await rowState(lane, "sess-b"),
      UPLOADED_ROW,
      "sess-b uploaded, settled, and no longer carries the reason it was paused for"
    );
    assert.equal(await lane.laneGaveUpAt(), null);
  });
});

test("ISS-9884 event door: an event that lands before the drain has seen a target switch re-arms the NEW target's give-up", async () => {
  await withLaneHarness(async (lane) => {
    // ct-2 gave up in an earlier session; its durable stamp is all that remains.
    await lane.store.recordLaneGiveUp(
      buildTranscriptSyncSourceKey("ct-2"),
      iso(START_MS)
    );
    lane.cloud.mode = CloudMode.Unauthorized;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    await lane.tickAt(START_MS);
    await lane.observeFresh("sess-b");

    // The identity changes, and its door fires before any pass has run under it.
    lane.cloud.mode = CloudMode.Healthy;
    lane.target.id = "ct-2";
    lane.service.noteLaneRecoverySignal();
    await lane.tickAt(START_MS + MINUTE_MS);

    assert.deepEqual(
      lane.planPostsFor("sess-b").map((post) => post.atMs),
      [START_MS + MINUTE_MS],
      "a minute into ct-2's five-minute window, so only the event can have opened it"
    );
    assert.equal(await lane.laneGaveUpAt("ct-2"), null);
  });
});

test("ISS-9884 window door: with no event at all, the widening window re-arms the lane once the cloud is back", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.Unauthorized;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    await lane.tickAt(START_MS);
    await lane.observeFresh("sess-b");

    lane.cloud.mode = CloudMode.Healthy;
    for (let minute = 1; minute < 5; minute += 1) {
      await lane.tickAt(START_MS + minute * MINUTE_MS);
    }
    assert.equal(
      lane.planPostsFor("sess-b").length,
      0,
      "a recovered cloud is not observed while the lane is given up"
    );

    await lane.tickAt(START_MS + 5 * MINUTE_MS);

    assert.equal(lane.planPostsFor("sess-b").length, 1);
    assert.deepEqual(
      await rowState(lane, "sess-b"),
      UPLOADED_ROW,
      "sess-b uploaded, settled, and no longer carries the reason it was paused for"
    );
    assert.equal(await lane.laneGaveUpAt(), null);
  });
});

test("ISS-9884 D-5: rows the skip-answering outage paused are anchored to the FIRST crossing, and the window revives and uploads them", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.BucketUnset;
    lane.cloud.recordedSkipReason = TranscriptSkipReason.EnvironmentUnavailable;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    await lane.seedStalledRow("sess-b", PAST_CEILING_MS);
    // sess-b's plan waits until sess-a's crossing is acked and is sent a minute
    // later: two rows crossing, in order, at two different instants.
    let releaseB: () => void = () => undefined;
    lane.cloud.beforePlan.set(
      "sess-b",
      new Promise<void>((resolve) => {
        releaseB = resolve;
      })
    );
    lane.cloud.onSkip = (externalSessionId) => {
      if (externalSessionId === "sess-a") {
        lane.clock.ms = START_MS + MINUTE_MS;
        releaseB();
      }
    };

    await lane.tickAt(START_MS);

    for (const externalSessionId of ["sess-a", "sess-b"]) {
      assert.equal(
        (await lane.store.get(externalSessionId, "main"))?.status,
        TranscriptSyncStatus.Dead,
        `${externalSessionId} was retired as its own clock crossed`
      );
      assert.equal(
        await lane.terminalSkipReason(externalSessionId),
        TranscriptSkipReason.EnvironmentUnavailable
      );
    }
    assert.deepEqual(
      lane.planPostsFor("sess-b").map((post) => post.atMs),
      [START_MS + MINUTE_MS],
      "sess-b genuinely crossed a minute after sess-a"
    );
    assert.equal(
      await lane.laneGaveUpAt(),
      iso(START_MS),
      "the stamp is the first crossing's, and the later crossing did not move it"
    );

    lane.cloud.mode = CloudMode.Healthy;
    await lane.tickAt(START_MS + 4 * MINUTE_MS);
    assert.equal(
      countPlanPosts(lane),
      2,
      "four minutes after the FIRST crossing the lane is still given up"
    );

    await lane.tickAt(START_MS + 5 * MINUTE_MS);

    assert.deepEqual(
      await rowState(lane, "sess-a"),
      UPLOADED_ROW,
      "sess-a uploaded, settled, and no longer carries the reason it was paused for"
    );
    assert.deepEqual(
      await rowState(lane, "sess-b"),
      UPLOADED_ROW,
      "sess-b uploaded, settled, and no longer carries the reason it was paused for"
    );
    assert.equal(
      await lane.laneGaveUpAt(),
      null,
      "and the answer they got cleared the lane"
    );
  });
});

test("ISS-9884: a revived row cannot buy a fresh run — its lane-wide failure re-stamps the lane and it waits for the next window", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.BucketUnset;
    lane.cloud.recordedSkipReason = TranscriptSkipReason.EnvironmentUnavailable;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    await lane.tickAt(START_MS);
    assert.equal(
      (await lane.store.get("sess-a", "main"))?.status,
      TranscriptSyncStatus.Dead
    );

    await lane.tickAt(START_MS + 5 * MINUTE_MS);

    const revived = await lane.store.get("sess-a", "main");
    assert.equal(
      revived?.status,
      TranscriptSyncStatus.Failed,
      "revived and attempted, and failed again"
    );
    assert.equal(
      revived?.laneStalledSince,
      iso(START_MS + 5 * MINUTE_MS),
      "the revival restarted its own run — which is exactly why the lane must bound it"
    );
    assert.equal(
      await lane.laneGaveUpAt(),
      iso(START_MS + 5 * MINUTE_MS),
      "that failure re-stamps the lane at once"
    );

    // The row's own floor makes it due at +10; the widened window opens at +15.
    for (let minute = 6; minute < 15; minute += 1) {
      await lane.tickAt(START_MS + minute * MINUTE_MS);
    }
    assert.equal(
      lane.planPostsFor("sess-a").length,
      2,
      "the crossing and the one revived attempt, and nothing inside the widened window"
    );

    await lane.tickAt(START_MS + 15 * MINUTE_MS);
    assert.equal(lane.planPostsFor("sess-a").length, 3);
  });
});

test("ISS-9884: rows paused before any give-up was on record are revived on the first pass", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.Healthy;
    await lane.observeFresh("sess-a");
    await lane.store.markDead({
      externalSessionId: "sess-a",
      fileKey: "main",
      reason: "paused while no lane give-up reached the record",
      terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
      terminalSkipComputeTargetId: COMPUTE_TARGET,
      now: iso(START_MS),
    });

    await lane.tickAt(START_MS);

    assert.equal(lane.planPostsFor("sess-a").length, 1);
    assert.deepEqual(
      await rowState(lane, "sess-a"),
      UPLOADED_ROW,
      "sess-a uploaded, settled, and no longer carries the reason it was paused for"
    );
  });
});

test("ISS-9884: a row paused under one compute target is revived by no door another target opens — only by its own", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.BucketUnset;
    lane.cloud.recordedSkipReason = TranscriptSkipReason.EnvironmentUnavailable;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    await lane.tickAt(START_MS);
    assert.equal(
      (await lane.store.get("sess-a", "main"))?.status,
      TranscriptSyncStatus.Dead,
      "paused under ct-1"
    );

    // Another identity takes over with the cloud healthy. It has never given up,
    // so its first hydration owes a revival, and the sign-in owes one as well.
    lane.cloud.mode = CloudMode.Healthy;
    lane.target.id = "ct-2";
    lane.service.noteLaneRecoverySignal();
    await lane.tickAt(START_MS + MINUTE_MS);

    assert.equal(
      (await lane.store.get("sess-a", "main"))?.status,
      TranscriptSyncStatus.Dead,
      "ct-1's paused transcript is not revived under ct-2"
    );
    assert.equal(
      lane.planPostsFor("sess-a").length,
      1,
      "and nothing of it is attempted under ct-2: the one post is the crossing that paused it"
    );

    // Back under the target that paused it, whose own window door has opened.
    lane.target.id = COMPUTE_TARGET;
    await lane.tickAt(START_MS + 5 * MINUTE_MS);

    assert.deepEqual(
      await rowState(lane, "sess-a"),
      UPLOADED_ROW,
      "its own target's door revives and uploads it"
    );
  });
});

test("ISS-9884: an attempt that began with no compute target is paused under none — not under the target that resolved mid-attempt — and its next attempt pauses it where a door can revive it", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.BucketUnset;
    lane.cloud.recordedSkipReason = TranscriptSkipReason.EnvironmentUnavailable;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    // The drain snapshots no target; a sign-in resolves ct-1 while the attempt
    // is in flight, so ct-1 is live when the crossing's skip is decided.
    lane.target.id = null;
    lane.cloud.onPlan = () => {
      lane.target.id = COMPUTE_TARGET;
    };

    await lane.tickAt(START_MS);

    assert.equal(lane.target.id, COMPUTE_TARGET, "ct-1 resolved mid-attempt");
    assert.deepEqual(
      skipTargetsFor(lane, "sess-a"),
      [],
      "no cloud is told of a pause for an attempt that ran under no target"
    );
    const held = await lane.store.get("sess-a", "main");
    assert.equal(
      held?.status,
      TranscriptSyncStatus.Failed,
      "so the row stays on the ladder instead of dead-lettering under no target"
    );
    assert.deepEqual(await pausedUnder(lane, "sess-a"), {
      terminalSkipReason: null,
      terminalSkipComputeTargetId: null,
    });

    lane.cloud.onPlan = () => undefined;
    const dueAt = held?.nextAttemptAt;
    assert.ok(dueAt, "a held row is scheduled, not stranded");
    const dueMs = Date.parse(dueAt);
    await lane.tickAt(dueMs);

    assert.deepEqual(
      skipTargetsFor(lane, "sess-a"),
      [COMPUTE_TARGET],
      "the next attempt ran under ct-1, and its crossing is acknowledged under ct-1"
    );
    assert.equal(
      (await lane.store.get("sess-a", "main"))?.status,
      TranscriptSyncStatus.Dead
    );
    assert.deepEqual(
      await pausedUnder(lane, "sess-a"),
      {
        terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
        terminalSkipComputeTargetId: COMPUTE_TARGET,
      },
      "the row records the target its pause was acknowledged under"
    );

    lane.cloud.mode = CloudMode.Healthy;
    await lane.tickAt(dueMs + 5 * MINUTE_MS);

    assert.deepEqual(
      await rowState(lane, "sess-a"),
      UPLOADED_ROW,
      "and ct-1's own door revives and uploads it"
    );
  });
});

/** The target each skip for `externalSessionId` was SENT under, from the wire. */
function skipTargetsFor(
  lane: LaneHarness,
  externalSessionId: string
): (string | null)[] {
  return lane.posts
    .filter(
      (post) =>
        post.path === SKIP_PATH && post.externalSessionId === externalSessionId
    )
    .map((post) => post.computeTargetId);
}

/** The raw persisted pause columns, so a NULL is told apart from a value. */
async function pausedUnder(lane: LaneHarness, externalSessionId: string) {
  const row = await lane.prisma.client.transcriptSyncState.findUnique({
    where: {
      externalSessionId_fileKey: { externalSessionId, fileKey: "main" },
    },
    select: { terminalSkipReason: true, terminalSkipComputeTargetId: true },
  });
  return {
    terminalSkipReason: row?.terminalSkipReason ?? null,
    terminalSkipComputeTargetId: row?.terminalSkipComputeTargetId ?? null,
  };
}

/** What an uploaded, settled transcript row reads as. */
const UPLOADED_ROW = {
  status: TranscriptSyncStatus.Idle,
  syncedByteOffset: UPLOADED_OFFSET,
  terminalSkipReason: null,
};

async function rowState(lane: LaneHarness, externalSessionId: string) {
  const row = await lane.store.get(externalSessionId, "main");
  return {
    status: row?.status,
    syncedByteOffset: row?.syncedByteOffset,
    terminalSkipReason: await lane.terminalSkipReason(externalSessionId),
  };
}

function countPlanPosts(lane: LaneHarness): number {
  return lane.posts.filter((post) => post.path === SYNC_PLAN_PATH).length;
}

/**
 * The kick fires its sweep and does not return it. A view over the live service
 * captures each sweep so the case can await the drain it ends with, rather than
 * guessing how many turns that takes.
 */
function captureSweeps(live: TranscriptSyncService): {
  service: TranscriptSyncService;
  sweeps: Promise<void>[];
} {
  const sweeps: Promise<void>[] = [];
  const service = Object.create(live) as TranscriptSyncService;
  service.sweepOnce = () => {
    const sweep = live.sweepOnce();
    sweeps.push(sweep);
    return sweep;
  };
  return { service, sweeps };
}
