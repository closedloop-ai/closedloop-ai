/**
 * @file transcript-lane-give-up.test.ts
 * @description ISS-9884 (PLN-1986 §4): the transcript lane's LANE give-up — what
 * stamps it, what it holds, what survives a relaunch, and what ends it.
 *
 * PLN-1961 §6's false-green warning is worse on this lane: its own staged backoff
 * already caps at 60 minutes, so "the next tick is quiet" is true of a merely
 * deferred lane and proves nothing about a give-up. Every hold below is asserted
 * against a transcript the backoff would NOT hold — one observed fresh, due at
 * once — or as silence outlasting the 60-minute cap, and the stamp is read back
 * off the durable column rather than off the object that wrote it.
 */
import assert from "node:assert/strict";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { test } from "vitest";
import {
  TRANSCRIPT_LANE_STALL_CEILING_MS,
  TRANSCRIPT_LANE_STALL_MAX_RETRY_MS,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import { TranscriptSyncStatus } from "../src/shared/transcript-sync-status-contract.js";
import {
  CloudMode,
  COMPUTE_TARGET,
  MINUTE_MS,
  START_MS,
  SYNC_PLAN_PATH,
  withLaneHarness,
} from "./helpers/transcript-lane-give-up-harness.js";

const iso = (ms: number) => new Date(ms).toISOString();

/** A row whose lane-wide run is already a minute past the ceiling. */
const PAST_CEILING_MS = START_MS - TRANSCRIPT_LANE_STALL_CEILING_MS - MINUTE_MS;

test("ISS-9884: a crossing whose terminal skip the cloud answers Uploaded releases the give-up, so the next ready transcript attempts at once", async () => {
  await withLaneHarness(async (lane) => {
    // The plan route is down lane-wide, so the row crosses the ceiling and the
    // lane gives up; the skip route still answers, and what it answers is that a
    // verified archive already exists.
    lane.cloud.mode = CloudMode.BucketUnset;
    lane.cloud.skipStatus = TranscriptUploadStatus.Uploaded;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);

    await lane.tickAt(START_MS);

    assert.equal(
      (await lane.store.get("sess-a", "main"))?.status,
      TranscriptSyncStatus.Idle,
      "precondition: the crossing's skip was answered Uploaded and settled readable"
    );

    lane.cloud.mode = CloudMode.Healthy;
    await lane.observeFresh("sess-b");
    await lane.tickAt(START_MS + MINUTE_MS);

    assert.deepEqual(
      lane.planPostsFor("sess-b").map((post) => post.atMs),
      [START_MS + MINUTE_MS],
      "a minute into what would be the give-up's five-minute window, so only the released lane lets it attempt"
    );
    assert.equal(
      await lane.laneGaveUpAt(),
      null,
      "and the durable stamp is cleared"
    );
  });
});

test("ISS-9884 AC2: a skip-refusing outage stamps the lane at the crossing, holds the drain, and dead-letters nothing", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.Unauthorized;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);

    await lane.tickAt(START_MS);

    assert.equal(
      await lane.laneGaveUpAt(),
      iso(START_MS),
      "the crossing stamps the durable column at the instant it was noticed"
    );

    // Due immediately, so the row's own backoff cannot be what keeps it quiet.
    await lane.observeFresh("sess-b");
    const endMs = START_MS + 12 * 60 * MINUTE_MS;
    for (let ms = START_MS + 5 * MINUTE_MS; ms < endMs; ms += 5 * MINUTE_MS) {
      await lane.tickAt(ms);
    }

    const planTimes = lane.posts
      .filter((post) => post.path === SYNC_PLAN_PATH)
      .map((post) => post.atMs);
    const longestGapMs = Math.max(
      ...planTimes.slice(1).map((atMs, index) => atMs - planTimes[index])
    );
    assert.ok(
      longestGapMs >= 4 * TRANSCRIPT_LANE_STALL_MAX_RETRY_MS,
      `a given-up lane stays silent far past the backoff's 60-minute cap; longest gap ${longestGapMs / MINUTE_MS}min`
    );
    assert.ok(
      planTimes.length <= 14,
      `twelve hours of a refused lane cost only the attempts its re-arms bought; got ${planTimes.length}`
    );
    for (const externalSessionId of ["sess-a", "sess-b"]) {
      const row = await lane.store.get(externalSessionId, "main");
      assert.equal(
        row?.status,
        TranscriptSyncStatus.Failed,
        `${externalSessionId} stays truthfully failed: nothing acked a terminal`
      );
      assert.equal(
        row?.retryCount,
        0,
        `${externalSessionId} is charged nothing for the outage`
      );
    }
    assert.equal(
      (await lane.store.get("sess-a", "main"))?.laneStalledSince,
      iso(PAST_CEILING_MS),
      "and the crossed row keeps its stall clock"
    );
  });
});

test("ISS-9884: a re-arm buys ONE attempt — its failure re-stamps at once and the lane holds again", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.Unauthorized;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    await lane.tickAt(START_MS);
    await lane.observeFresh("sess-b");

    // The window arm opens five minutes after the first give-up.
    await lane.tickAt(START_MS + 5 * MINUTE_MS);

    assert.deepEqual(
      lane.planPostsFor("sess-b").map((post) => post.atMs),
      [START_MS + 5 * MINUTE_MS],
      "the re-arm spends its attempt on the transcript that was waiting"
    );
    assert.equal(
      await lane.laneGaveUpAt(),
      iso(START_MS + 5 * MINUTE_MS),
      "and that attempt's failure re-stamps the lane at the failure"
    );

    // sess-b's own floor makes it due at +10; the widened window reopens at +15.
    for (let minute = 6; minute < 15; minute += 1) {
      await lane.tickAt(START_MS + minute * MINUTE_MS);
    }
    assert.equal(
      lane.planPostsFor("sess-b").length,
      1,
      "nothing is attempted inside the widened window, though the row itself is due"
    );

    await lane.tickAt(START_MS + 15 * MINUTE_MS);
    assert.equal(
      lane.planPostsFor("sess-b").length,
      2,
      "and the next window buys the next attempt"
    );
  });
});

test("ISS-9884: the stamp survives a relaunch — the new process holds rather than opening a fresh 24h run", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.Unauthorized;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    await lane.tickAt(START_MS);

    lane.relaunch();
    lane.clock.ms = START_MS + 2 * MINUTE_MS;
    await lane.observeFresh("sess-b");
    for (let minute = 2; minute < 5; minute += 1) {
      await lane.tickAt(START_MS + minute * MINUTE_MS);
    }

    assert.equal(
      lane.planPostsFor("sess-b").length,
      0,
      "the relaunched lane holds a transcript due now, on nothing but the durable stamp"
    );
    assert.equal(
      await lane.laneGaveUpAt(),
      iso(START_MS),
      "and leaves the stamp it adopted where it was"
    );

    await lane.tickAt(START_MS + 5 * MINUTE_MS);

    assert.equal(
      lane.planPostsFor("sess-b").length,
      1,
      "the window measured from the ADOPTED stamp re-arms it"
    );
    assert.equal(
      await lane.laneGaveUpAt(),
      iso(START_MS + 5 * MINUTE_MS),
      "and a fresh row's failure re-stamps at once — which only a lane that knows it gave up does; a fresh run would stamp nothing for a day"
    );
  });
});

test("ISS-9884: a compute-target switch is a different give-up row — the new target is not held by the old one's", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.Unauthorized;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    await lane.tickAt(START_MS);

    lane.target.id = "ct-2";
    await lane.observeFresh("sess-b");
    await lane.tickAt(START_MS + MINUTE_MS);

    assert.equal(
      lane.planPostsFor("sess-b").length,
      1,
      "the switched lane attempts at once, inside the old target's window"
    );
    assert.equal(
      await lane.laneGaveUpAt(COMPUTE_TARGET),
      iso(START_MS),
      "the previous target's give-up stays on its own row"
    );
    assert.equal(
      await lane.laneGaveUpAt("ct-2"),
      null,
      "and a failure that crossed nothing stamps nothing for the new one"
    );
  });
});

test("ISS-9884: a row-attributable answer ends the give-up — a 409 is the server reaching the lane", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.Unauthorized;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);
    await lane.tickAt(START_MS);
    await lane.observeFresh("sess-b");

    lane.cloud.mode = CloudMode.Conflict;
    await lane.tickAt(START_MS + 5 * MINUTE_MS);

    assert.equal(lane.planPostsFor("sess-b").length, 1);
    assert.equal(
      await lane.laneGaveUpAt(),
      null,
      "a 409 was judged against those bytes, so the lane is reachable and the stamp is cleared"
    );

    await lane.observeFresh("sess-c");
    await lane.tickAt(START_MS + 6 * MINUTE_MS);

    assert.equal(
      lane.planPostsFor("sess-c").length,
      1,
      "and the lane attempts again without waiting out a window"
    );
  });
});

test("ISS-9884: a skip the cloud records with NO reason persists NULL, and the recovery door leaves that row dead", async () => {
  await withLaneHarness(async (lane) => {
    lane.cloud.mode = CloudMode.BucketUnset;
    lane.cloud.recordedSkipReason = null;
    await lane.seedStalledRow("sess-a", PAST_CEILING_MS);

    await lane.tickAt(START_MS);

    assert.equal(
      (await lane.store.get("sess-a", "main"))?.status,
      TranscriptSyncStatus.Dead,
      "the skip route answered, so the crossing retired the row"
    );
    assert.equal(
      await lane.terminalSkipReason("sess-a"),
      null,
      "what the cloud RECORDED is persisted — no reason — not the reason the lane asked for"
    );
    assert.equal(await lane.laneGaveUpAt(), iso(START_MS));

    lane.cloud.mode = CloudMode.Healthy;
    await lane.tickAt(START_MS + 5 * MINUTE_MS);

    assert.equal(
      (await lane.store.get("sess-a", "main"))?.status,
      TranscriptSyncStatus.Dead,
      "a NULL reason is no evidence the environment was the cause, so the door does not revive it"
    );
    assert.equal(lane.planPostsFor("sess-a").length, 1);
  });
});
