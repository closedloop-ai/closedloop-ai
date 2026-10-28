/**
 * @file transcript-lane-stall-backoff.test.ts
 * @description ISS-8689 acceptance: a repeated configuration-class 503 stops
 * growing the request count, and a transient one still recovers quickly.
 *
 * The ticket is explicit that asserting a retry happened, or that a backoff was
 * called, does NOT satisfy it — the defect is unbounded repetition, so the BOUND
 * is what has to be pinned. So these cases drive the real drain loop over a
 * simulated 24h+ window and count actual `POST /desktop/transcripts/sync-plan`
 * requests off a stubbed `fetch`, through the real `createDesktopTranscriptsClient`.
 * Counting stubbed executor calls instead would prove nothing about the path
 * that produced the 835 measured requests.
 *
 * The store is the REAL one, on a real libSQL database, for the same reason the
 * client is real. The shared fake in `helpers/transcript-sync-fixtures.ts`
 * returns its seeded array from `listReady` unconditionally and never writes a
 * settle back, so a window driven against it could not observe a deadline at
 * all — its plateau would be an artifact of the harness. A hand-written stateful
 * fake is no better here: this suite exists to prove that the STORE's revive
 * rules and the DRAIN's schedule compose into a bound, and a fake that
 * reimplements either half assumes the very thing under test. So `observe`,
 * `listReady` and every settle below run production code end to end.
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { test } from "vitest";
import { createTranscriptSyncStore } from "../src/main/database/transcript-sync-store.js";
import { createDesktopTranscriptsClient } from "../src/main/transcript/desktop-transcripts-client.js";
import type { TranscriptSyncExecutor } from "../src/main/transcript-sync/transcript-sync-executor.js";
import {
  TRANSCRIPT_LANE_STALL_CEILING_MS,
  TRANSCRIPT_LANE_STALL_MAX_RETRY_MS,
  TRANSCRIPT_LANE_STALL_RETRY_MS,
  TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES,
  type TranscriptFingerprint,
  transcriptLaneStallDelayMs,
  transcriptLaneStallRetryMs,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  fakeScheduler,
  makeService,
} from "./helpers/transcript-sync-fixtures.js";
import { observeInput } from "./helpers/transcript-sync-store-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const START_MS = Date.parse("2026-07-09T00:00:00.000Z");
const SYNC_PLAN_PATH = "/desktop/transcripts/sync-plan";
const SKIP_PATH = "/desktop/transcripts/skip";
/** ISS-8608: where the stubbed presigned uploads go, so the leg is identifiable. */
const UPLOAD_ORIGIN = "https://s3.test";
const UPLOAD_PATH = "/presigned";
/** ISS-9793: a presigned target, so the upload arm is distinguishable in `posts`. */
const UPLOAD_URL = "https://s3.test/transcripts/part";

/** What the server sends for a bucket-unset 503 (an hour) vs a blip (a minute). */
const CONFIG_RETRY_AFTER = "3600";
const TRANSIENT_RETRY_AFTER = "60";

type PostLog = { path: string; atMs: number };

/**
 * Drive the lane over `windowMs` of simulated time against a server that always
 * answers `status` (503 unless a case says otherwise), and return every control
 * POST it actually made.
 *
 * `skipAcked` false makes the terminal skip itself fail, which is the ack-gated
 * branch (`transcript-drain-queue.ts`): the row stays `failed` rather than going
 * `dead`, so the bound has to come from the schedule alone.
 *
 * `fileChangeEveryMs` models a live session: the ~5 minute activity debounce
 * re-observes a growing transcript, which is a real `store.observe` here, so the
 * revive rules under test are the ones that actually run.
 *
 * ISS-9693/ISS-9695 took the status from a hardcoded 503 to a parameter. The
 * classification cases below need the SAME real loop — real store, real client,
 * real `recordFailure` — because what they assert is which counter a status
 * moves, and every fake that has ever stood in for one of these halves decided
 * that answer itself.
 */
async function drivePersistentFailure(options: {
  retryAfter: string | null;
  windowMs: number;
  tickMs: number;
  status?: number;
  skipAcked?: boolean;
  fileChangeEveryMs?: number;
  /**
   * Which leg fails. `control` (the default) keeps every existing case exactly
   * as it was — the executor calls `syncPlan` and that POST is what the server
   * rejects.
   *
   * `upload` (ISS-9793) calls the real `put` directly on a fixed presigned
   * target, so a REQUEST-LEVEL failure — a rejected fetch, no HTTP answer at
   * all — is driven on the upload arm without a plan in the way.
   *
   * `fullPut`/`part` (ISS-8608) instead let the plan SUCCEED and fail the
   * presigned upload with an ANSWER, which is the arm S3's `<Code>` classifies.
   *
   * A parameter rather than a second driver: this harness already exists to keep
   * classification cases on ONE real store, client, drain and clock, and a copy
   * would have duplicated all four for a difference of two lines.
   */
  arm?: "control" | "upload" | "fullPut" | "part";
  /** The S3 error body served on the upload leg, when `arm` is an upload one. */
  body?: string;
  /**
   * ISS-8608 recovery: the attempt number (1-based) from which the upload
   * SUCCEEDS. Models a presign that expired and was re-planned — the executor
   * re-plans on every attempt, so attempt 2 gets a fresh URL.
   */
  uploadSucceedsFromAttempt?: number;
  /**
   * ISS-9793: what the stub does with the request under test, replacing the
   * status answer above. A rejected promise is the offline arm — no HTTP answer
   * ever exists — and a 200 carrying an unusable body is the version-skew one.
   * The SKIP request is deliberately NOT routed through here and keeps acking,
   * so a regression that resumes spending the budget can reach its terminal and
   * each case pins that it did not: the counter, the absence of a skip, and the
   * row still reading `failed`.
   */
  respond?: () => Promise<Response>;
  /** `""` is the signed-out desktop: `resolveControlUrl` throws before any fetch. */
  apiOrigin?: string;
  /**
   * A REJECTING credential source (whitlockk review). This is a separately wrapped
   * throw site in `resolveControlUrl`, two lines above the "not signed in"
   * branch `apiOrigin: ""` reaches — so the empty-origin case cannot stand in
   * for it.
   */
  getAccessToken?: () => Promise<string | null>;
}): Promise<{
  posts: PostLog[];
  row: TranscriptFingerprint | null;
  uploadUrls: string[];
}> {
  const posts: PostLog[] = [];
  const uploadUrls: string[] = [];
  const clock = { ms: START_MS };
  const nowIso = () => new Date(clock.ms).toISOString();
  const arm = options.arm ?? "control";
  let planCount = 0;
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    await store.observe(observeInput({ syncClass: "live", now: nowIso() }));

    const client = createDesktopTranscriptsClient({
      // `postControl` passes a `URL`; `put` passes the raw presigned STRING, so
      // the first argument is normalized before anything reads a pathname and
      // one counter serves both arms.
      fetch: ((target: URL | string) => {
        const url = new URL(String(target));
        posts.push({ path: url.pathname, atMs: clock.ms });
        if (url.pathname === SKIP_PATH && options.skipAcked !== false) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                status: TranscriptUploadStatus.Skipped,
                permanentFailureReason: null,
                sessionDetailId: null,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }
        if (
          (arm === "fullPut" || arm === "part") &&
          url.pathname === SYNC_PLAN_PATH
        ) {
          // The plan succeeds so the upload leg is the one under test. A fresh
          // presigned URL every attempt is what re-planning actually buys.
          planCount += 1;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                mode: "fullPut",
                url: `${UPLOAD_ORIGIN}${UPLOAD_PATH}/${planCount}`,
                planEndOffset: 100,
                syncedByteOffset: 0,
                storedEtag: null,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }
        if (url.pathname.startsWith(UPLOAD_PATH)) {
          uploadUrls.push(url.pathname);
          const succeedsFrom = options.uploadSucceedsFromAttempt;
          if (succeedsFrom !== undefined && planCount >= succeedsFrom) {
            return Promise.resolve(new Response(null, { status: 200 }));
          }
          return Promise.resolve(
            new Response(options.body ?? "upstream unavailable", {
              status: options.status ?? 503,
              headers: options.retryAfter
                ? { "Retry-After": options.retryAfter }
                : {},
            })
          );
        }
        if (options.respond) {
          return options.respond();
        }
        return Promise.resolve(
          new Response("upstream unavailable", {
            status: options.status ?? 503,
            headers: options.retryAfter
              ? { "Retry-After": options.retryAfter }
              : {},
          })
        );
      }) as unknown as typeof fetch,
      getAccessToken:
        options.getAccessToken ?? (() => Promise.resolve("token")),
      getApiOrigin: () => options.apiOrigin ?? "https://api.test",
    });

    // The executor is a fake only in what it SKIPS — reading real bytes off
    // disk. Both cloud calls it makes are the real client, so every POST counted
    // below is a real request built by production code, and every error the
    // drain classifies is a real `TranscriptSyncClientError` carrying the real
    // header off the real response.
    const executor = {
      syncFile: async (fp: TranscriptFingerprint) => {
        if (arm === "upload") {
          // ISS-9793: the upload arm reached without a plan, so the failure
          // under test is the request itself rather than an answer to it.
          return await client.uploadPut(
            UPLOAD_URL,
            Readable.from([Buffer.from("transcript bytes")]),
            16,
            "crc64"
          );
        }
        const plan = await client.syncPlan({
          computeTargetId: "ct-1",
          externalSessionId: fp.externalSessionId,
          fileKey: fp.fileKey,
          sourceHarness: "claude",
          sourcePathHash: fp.sourcePathHash,
          sourceMtime: 1000,
          planEndOffset: 100,
        } as never);
        if (arm === "control") {
          return plan;
        }
        // ISS-8608: the upload leg, through the REAL client, so the error the
        // drain classifies carries the fields `put` actually sets — including
        // the arm marker, which no hand-built error could prove.
        const url = (plan as { url: string }).url;
        if (arm === "part") {
          await client.uploadPart(url, Readable.from(["bytes"]), 5);
        } else {
          await client.uploadPut(url, Readable.from(["bytes"]), 5, "crc64");
        }
        return { kind: "uploaded" as const, caughtUp: true };
      },
      notifyPermanentSkip: async (
        fp: TranscriptFingerprint,
        reason: string
      ) => {
        try {
          const response = await client.skip({
            computeTargetId: "ct-1",
            externalSessionId: fp.externalSessionId,
            fileKey: fp.fileKey,
            sourceHarness: "claude",
            reason,
          } as never);
          return {
            acked: true as const,
            status: response.status,
            // ISS-9884: the reason the server RECORDED. This double already
            // holds the response it reads `status` from, so echoing the
            // request back would model an executor this lane no longer has.
            reason: response.permanentFailureReason,
          };
        } catch {
          return { acked: false as const };
        }
      },
    } as unknown as TranscriptSyncExecutor;

    const { service } = makeService({
      store: store as never,
      executor,
      scheduler: fakeScheduler().scheduler,
      getComputeTargetId: () => "ct-1",
      now: nowIso,
    });

    const endMs = START_MS + options.windowMs;
    let lastChangeMs = START_MS;
    let grownSize = 500;
    while (clock.ms < endMs) {
      if (
        options.fileChangeEveryMs !== undefined &&
        clock.ms - lastChangeMs >= options.fileChangeEveryMs
      ) {
        lastChangeMs = clock.ms;
        grownSize += 100;
        await store.observe(
          observeInput({
            syncClass: "live",
            mtimeMs: 1000 + grownSize,
            size: grownSize,
            now: nowIso(),
          })
        );
      }
      await service.drainOnce();
      clock.ms += options.tickMs;
    }
    return { posts, row: await store.get("sess-1", "main"), uploadUrls };
  } finally {
    await close();
  }
}

const syncPlanPosts = (posts: PostLog[]) =>
  posts.filter((post) => post.path === SYNC_PLAN_PATH);

test("ISS-8689 AC: a repeated configuration 503 stops growing the request count", async () => {
  // 48h — twice the give-up ceiling — so a schedule that merely slowed the
  // storm down would still be caught by the second day's growth.
  const { posts, row } = await drivePersistentFailure({
    retryAfter: CONFIG_RETRY_AFTER,
    windowMs: 2 * TRANSCRIPT_LANE_STALL_CEILING_MS,
    // The floor is five minutes, so a five-minute tick can never step OVER a
    // due attempt and under-count.
    tickMs: 5 * 60_000,
  });

  const plans = syncPlanPosts(posts);
  const skips = posts.filter((post) => post.path === SKIP_PATH);

  assert.ok(
    plans.every(
      (post) => post.atMs <= START_MS + TRANSCRIPT_LANE_STALL_CEILING_MS
    ),
    "the count PLATEAUS: the whole second day adds no sync-plan request at all"
  );
  assert.ok(
    plans.length <= 30,
    `a day of a permanently-broken bucket must cost tens of requests, not hundreds; got ${plans.length}`
  );
  assert.equal(
    skips.length,
    1,
    "the terminal skip is one more request, and it is counted here rather than excused"
  );
  assert.equal(
    row?.status,
    "dead",
    "and the run reaches its terminal path rather than merely going quiet"
  );
});

test("ISS-8689 AC: the count still plateaus when the terminal skip ack FAILS", async () => {
  // Dead-lettering is ack-gated, so a skip the cloud never records leaves the
  // row `failed` and on the ladder — there is no terminal to stop it and the
  // schedule is the ONLY bound. It must still be a bound.
  const { posts, row } = await drivePersistentFailure({
    retryAfter: CONFIG_RETRY_AFTER,
    windowMs: 2 * TRANSCRIPT_LANE_STALL_CEILING_MS,
    tickMs: 5 * 60_000,
    skipAcked: false,
  });

  const plans = syncPlanPosts(posts);
  assert.equal(row?.status, "failed", "an unacked skip must not dead-letter");
  assert.ok(
    plans.length <= 60,
    `two days on the capped rung is ~1/hour, not a storm; got ${plans.length}`
  );
});

test("ISS-8689 AC: a live file changing every 5 minutes cannot re-open the storm", async () => {
  // This is the measured shape of the 835-request session: the ~5 min activity
  // debounce re-observes a growing transcript and re-queues it. Before this
  // ticket that revive cleared the deadline, so the lane POSTed on the FILE's
  // cadence and no backoff it computed could survive — 288 requests a day per
  // file, whatever the schedule said.
  const { posts } = await drivePersistentFailure({
    retryAfter: CONFIG_RETRY_AFTER,
    windowMs: TRANSCRIPT_LANE_STALL_CEILING_MS,
    tickMs: 5 * 60_000,
    fileChangeEveryMs: 5 * 60_000,
  });

  const plans = syncPlanPosts(posts);
  assert.ok(
    plans.length <= 30,
    `a file changing 288 times a day must not buy 288 requests; got ${plans.length}`
  );
});

test("ISS-8689: a TRANSIENT 503 still opens on today's five-minute cadence", async () => {
  // The other half of the acceptance criteria. A cloud blip must not inherit
  // the configuration stand-down: the first attempt after it is where recovery
  // is most likely, and a lane that waited an hour there would turn a 90-second
  // outage into an hour of staleness.
  const { posts } = await drivePersistentFailure({
    retryAfter: TRANSIENT_RETRY_AFTER,
    windowMs: 30 * 60_000,
    // A one-minute tick so the exact gap between the first two attempts is
    // observable, rather than rounded up to the tick.
    tickMs: 60_000,
  });

  const plans = syncPlanPosts(posts);
  assert.ok(plans.length >= 2, "it must keep retrying");
  assert.equal(
    plans[1].atMs - plans[0].atMs,
    TRANSCRIPT_LANE_STALL_RETRY_MS,
    "the first retry lands on the 5-minute floor, exactly as it does today"
  );
  assert.ok(
    plans[2].atMs - plans[1].atMs > TRANSCRIPT_LANE_STALL_RETRY_MS,
    "and only then does the schedule stage up"
  );
});

test("ISS-8689: the schedule's literal rungs are 5, 10, 20, 40 then 60 minutes", () => {
  // Pinned as LITERAL minutes, not derived from the constants, because the two
  // sibling cases below are both self-derived: they would survive a retune of
  // the floor or the cap that silently changed the lane's real-world cadence.
  // The numbers are the contract the ticket's request-count budget rests on.
  const MINUTE = 60_000;
  const rungs = [0, 5, 15, 35, 75, 24 * 60].map(
    (ageMinutes) => transcriptLaneStallRetryMs(ageMinutes * MINUTE) / MINUTE
  );

  assert.deepEqual(rungs, [5, 10, 20, 40, 60, 60]);
});

test("ISS-8689: the staged schedule doubles from the floor and stops at the cap", () => {
  assert.equal(
    transcriptLaneStallRetryMs(0),
    TRANSCRIPT_LANE_STALL_RETRY_MS,
    "a fresh stall opens on the floor"
  );
  assert.equal(
    transcriptLaneStallRetryMs(TRANSCRIPT_LANE_STALL_RETRY_MS),
    2 * TRANSCRIPT_LANE_STALL_RETRY_MS
  );
  assert.equal(
    transcriptLaneStallRetryMs(3 * TRANSCRIPT_LANE_STALL_RETRY_MS),
    4 * TRANSCRIPT_LANE_STALL_RETRY_MS
  );
  assert.equal(
    transcriptLaneStallRetryMs(TRANSCRIPT_LANE_STALL_CEILING_MS),
    TRANSCRIPT_LANE_STALL_MAX_RETRY_MS,
    "and it is pinned at the cap long before the run ends"
  );
  for (const age of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(
      transcriptLaneStallRetryMs(age),
      TRANSCRIPT_LANE_STALL_RETRY_MS,
      `an age of ${age} is not evidence anything should wait longer`
    );
  }
});

test("ISS-8689: Retry-After is honored as a MINIMUM, never as a ceiling on the schedule", () => {
  // A `min` here is the mutation that matters: the transient hint is 60s, so a
  // `min` would pin every stalled row to a minute forever and delete the
  // staging entirely — while still passing any test that only checked the
  // header was read.
  const lateStallMs = START_MS - 3 * TRANSCRIPT_LANE_STALL_MAX_RETRY_MS;
  assert.equal(
    transcriptLaneStallDelayMs({
      stalledSinceMs: lateStallMs,
      nowMs: START_MS,
      retryAfterMs: 60_000,
    }),
    TRANSCRIPT_LANE_STALL_MAX_RETRY_MS,
    "a short server hint cannot shorten an already-staged schedule"
  );
  assert.equal(
    transcriptLaneStallDelayMs({
      stalledSinceMs: START_MS,
      nowMs: START_MS,
      retryAfterMs: 3_600_000,
    }),
    3_600_000,
    "but a long one is honored immediately, before staging would reach it"
  );
  assert.equal(
    transcriptLaneStallDelayMs({
      stalledSinceMs: START_MS,
      nowMs: START_MS,
      retryAfterMs: undefined,
    }),
    TRANSCRIPT_LANE_STALL_RETRY_MS,
    "and an absent header leaves the schedule to decide"
  );
});

test("ISS-8689: a Retry-After longer than the whole run is clamped, not discarded", () => {
  // A hint beyond the 24h budget is not a schedule. Clamping it to the ceiling
  // keeps it HONORED as far as it can be; the alternative — treating it as
  // unreadable — would drop a server's explicit instruction back to a
  // five-minute retry, which is the opposite of what it asked for.
  assert.equal(
    transcriptLaneStallDelayMs({
      stalledSinceMs: START_MS - TRANSCRIPT_LANE_STALL_CEILING_MS - 1000,
      nowMs: START_MS,
      retryAfterMs: 8 * 24 * 3_600_000,
    }),
    TRANSCRIPT_LANE_STALL_CEILING_MS,
    "an eight-day hint on a spent run waits the ceiling, not eight days"
  );
});

test("ISS-8689: a delay can never be scheduled past the give-up instant", () => {
  // The ceiling is only evaluated when an attempt actually runs, so a late
  // server hint that pushed `nextAttemptAt` beyond `stalledSince + 24h` would
  // schedule the terminal path out of reach — the row would wait, then wake up
  // already past its own deadline, having spent hours doing neither.
  const oneHourLeft = START_MS - (TRANSCRIPT_LANE_STALL_CEILING_MS - 3_600_000);
  assert.equal(
    transcriptLaneStallDelayMs({
      stalledSinceMs: oneHourLeft,
      nowMs: START_MS,
      retryAfterMs: 10 * 3_600_000,
    }),
    3_600_000,
    "a ten-hour hint with an hour of budget left is capped at the hour"
  );
  // A run PAST its ceiling is a different case, and the first draft of this got
  // it wrong: clamping the spent budget to zero looks like "terminate now" but
  // is really "retry on every tick", because dead-lettering is ack-gated and a
  // cloud that cannot record the terminal skip leaves the row right here. The
  // AC suite above measured 1,464 requests in two days from that mistake — a
  // hot loop strictly worse than the flat delay this ticket replaced.
  assert.equal(
    transcriptLaneStallDelayMs({
      stalledSinceMs: START_MS - 2 * TRANSCRIPT_LANE_STALL_CEILING_MS,
      nowMs: START_MS,
      retryAfterMs: 3_600_000,
    }),
    3_600_000,
    "a run past its ceiling keeps its schedule; the terminal is what stops it, not a zero delay"
  );
});

/**
 * A window comfortably inside the 24h give-up ceiling, so anything terminal that
 * happens in these cases came from the RETRY LADDER and not from the wall clock.
 */
const HALF_CEILING_MS = TRANSCRIPT_LANE_STALL_CEILING_MS / 2;

test("ISS-9693 AC: a platform 404 defers the lane with retryCount frozen and skips nothing", async () => {
  // The defect this closes is not cadence. Before the fix a deploy-skew 404 was
  // absent from the lane-wide set, so `recordFailure` took the `retryCount + 1`
  // arm; five of them made the row dead-letter-eligible and the lane POSTed a
  // `retries_exhausted` skip — telling the cloud a healthy transcript had been
  // legitimately given up on, for a condition no file caused and every file
  // shares. So what is asserted is the COUNTER and the SKIP, not the delay.
  const { posts, row } = await drivePersistentFailure({
    status: 404,
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(
    row?.retryCount,
    0,
    "a 404 charges nothing to the row: the per-row ladder never advances"
  );
  assert.equal(
    posts.filter((post) => post.path === SKIP_PATH).length,
    0,
    "and no `retries_exhausted` skip is even ATTEMPTED, so the cloud is never told this row was given up on"
  );
  assert.equal(
    row?.status,
    "failed",
    "the row stays truthfully failed, not dead"
  );
  assert.ok(
    syncPlanPosts(posts).length <= 20,
    `a deferred lane polls on the staged schedule, not the 5-minute tick; got ${syncPlanPosts(posts).length}`
  );
});

test("ISS-9695 AC: a status this build has never seen inherits the environmental default", async () => {
  // 499 is a real intermediary status (nginx client-closed) that no branch in
  // this build names, which is the whole point: the predicate is an allow-list
  // of the statuses that KEEP the ladder, so an unrecognized one takes the safe
  // answer without anybody editing a set. Written as a literal here rather than
  // read from the set it polices — a case that imported the predicate's own
  // inventory would stay green if that inventory were emptied.
  const { posts, row } = await drivePersistentFailure({
    status: 499,
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(
    row?.retryCount,
    0,
    "an unrecognized status must not be guessed as the item's fault"
  );
  assert.equal(
    posts.filter((post) => post.path === SKIP_PATH).length,
    0,
    "and must not walk the row to an acked `retries_exhausted` skip"
  );
  assert.equal(row?.status, "failed");
});

test("ISS-9693/ISS-9695 sibling: a 400 STILL walks the ladder to an acked dead-letter", async () => {
  // The positive control for both cases above. "A 404 does not consume an
  // attempt" is only meaningful if some status still does — without this, a
  // predicate hardwired to `true` would pass every assertion in this file, and
  // the lane would have stopped dead-lettering genuinely-poison rows.
  const { posts, row } = await drivePersistentFailure({
    status: 400,
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(
    row?.retryCount,
    TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES,
    "a deterministic 8 KiB control body the server rejected IS attributable to the row, so it spends the budget"
  );
  assert.equal(
    posts.filter((post) => post.path === SKIP_PATH).length,
    1,
    "and reaches the terminal skip exactly once"
  );
  assert.equal(
    row?.status,
    "dead",
    "which the cloud acked, so the row is dead"
  );
});

// ISS-8608 (PRD-699 Appendix A exception 4 / F6). The cases above all fail the
// CONTROL POST; these fail the PRESIGNED UPLOAD, which `recordFailure`
// classifies through the same predicate and which — until this change — only
// ever offered it S3's bare status. They run the same real store, real client
// and real drain, so what is asserted is the counter the real `recordFailure`
// actually moved, not a fake's opinion of it.

/** S3's XML error body for one code. */
const s3Body = (code: string) =>
  `<Error><Code>${code}</Code><Message>rejected</Message></Error>`;

test("ISS-8608 AC: an expired presign leaves the row budget untouched and skips nothing", async () => {
  // The ticket's own acceptance criterion. Before this, a presign that expired
  // under a slow upload spent five attempts and told the cloud the transcript
  // had been legitimately given up on — for a condition no file caused.
  const { posts, row } = await drivePersistentFailure({
    arm: "fullPut",
    status: 403,
    body: s3Body("ExpiredToken"),
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(
    row?.retryCount,
    0,
    "an expired URL charges nothing to the row: the per-row ladder never advances"
  );
  assert.equal(
    posts.filter((post) => post.path === SKIP_PATH).length,
    0,
    "and no `retries_exhausted` skip is even ATTEMPTED"
  );
  assert.equal(
    row?.status,
    "failed",
    "the row stays truthfully failed, not dead"
  );
});

test("ISS-8608: a bucket-policy denial is treated the same as an expiry", async () => {
  // Both are conditions of the URL or the bucket, which every row shares, so
  // neither is attributable to these bytes. Recorded as a deliberate divergence
  // from Appendix A's per-lane worksheet in the conformance ledger.
  const { row } = await drivePersistentFailure({
    arm: "fullPut",
    status: 403,
    body: s3Body("AccessDenied"),
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(row?.retryCount, 0);
  assert.equal(row?.status, "failed");
});

test("ISS-8608: a socket that stalls MID-PART leaves the row budget untouched", async () => {
  // The motivating failure, on the arm it actually happens on.
  const { posts, row } = await drivePersistentFailure({
    arm: "part",
    status: 400,
    body: s3Body("IncompleteBody"),
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(row?.retryCount, 0);
  assert.equal(posts.filter((post) => post.path === SKIP_PATH).length, 0);
});

test("ISS-8608: an S3 body with no readable code leaves the row budget untouched", async () => {
  // The malformed-XML acceptance criterion, over the real drain.
  const { row } = await drivePersistentFailure({
    arm: "fullPut",
    status: 400,
    body: "not xml at all",
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(row?.retryCount, 0);
  assert.equal(row?.status, "failed");
});

// THE POSITIVE CONTROL on this arm. Without a code that still walks the ladder,
// a classifier hardwired to "environmental" would pass every case above while
// the lane had quietly stopped dead-lettering objects S3 will never accept.
test("ISS-8608: an oversize object STILL walks the ladder to an acked dead-letter", async () => {
  const { posts, row } = await drivePersistentFailure({
    arm: "fullPut",
    status: 400,
    body: s3Body("EntityTooLarge"),
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(
    row?.retryCount,
    TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES,
    "an object S3 will never accept keeps the terminal door this change must not remove"
  );
  assert.equal(
    posts.filter((post) => post.path === SKIP_PATH).length,
    1,
    "and reaches the terminal skip exactly once"
  );
  assert.equal(row?.status, "dead");
});

// THE STATUS GATE, over the real drain. The refinement is scoped to Appendix A's
// 400/403; a 409 must keep the ladder even when its body carries a code the
// refinement would otherwise call environmental.
test("ISS-8608 STATUS GATE: a 409 STILL walks the ladder, environmental-looking code and all", async () => {
  const { posts, row } = await drivePersistentFailure({
    arm: "fullPut",
    status: 409,
    body: s3Body("RequestTimeout"),
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(
    row?.retryCount,
    TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES,
    "a status the refinement is not scoped to is declined, not answered"
  );
  assert.equal(posts.filter((post) => post.path === SKIP_PATH).length, 1);
  assert.equal(row?.status, "dead");
});

// THE OTHER HALF OF THE TICKET'S ACCEPTANCE CRITERION: "re-plans and SUCCEEDS".
// Every case above proves the accounting; none proves recovery. The executor
// re-plans on EVERY attempt, so the second attempt gets a fresh presigned URL —
// this drives that end to end and asserts the upload then goes through with the
// row's budget never having moved.
test("ISS-8608 AC: an expired presign re-plans on the next attempt and succeeds", async () => {
  const { posts, row, uploadUrls } = await drivePersistentFailure({
    arm: "fullPut",
    status: 403,
    body: s3Body("ExpiredToken"),
    uploadSucceedsFromAttempt: 2,
    retryAfter: null,
    windowMs: 60 * 60_000,
    tickMs: 5 * 60_000,
  });

  assert.ok(
    syncPlanPosts(posts).length >= 2,
    `recovery requires a second plan; got ${syncPlanPosts(posts).length}`
  );
  assert.notEqual(
    uploadUrls[0],
    uploadUrls[1],
    "the second attempt uploads to a FRESH presigned URL — that is what re-planning buys"
  );
  assert.equal(
    row?.retryCount,
    0,
    "and the whole recovery cost the row's budget nothing"
  );
  assert.equal(
    posts.filter((post) => post.path === SKIP_PATH).length,
    0,
    "a transcript that uploaded successfully must never have been skipped"
  );
});

/**
 * ISS-9793. The four cases below drive the SEVEN status-less throw sites in
 * `desktop-transcripts-client.ts` — sites the row ladder used to charge because
 * `recordFailure` never settled the "no HTTP answer" question its predicate said
 * each caller would settle for itself.
 *
 * They are four rather than seven because three sites are the same ruling
 * reached through the same mechanism: an unavailable access token and an invalid
 * API origin throw from `resolveControlUrl` exactly as "not signed in" does, and
 * a non-JSON body is the unusable-body case a failed schema validation already
 * pins. A fourth and fifth case there would assert the same settle off the same
 * arm and prove nothing further.
 *
 * The SKIP request keeps acking in the three `respond`-driven cases, so a
 * regression there reaches its terminal and each pins that it did not: the
 * counter, the absence of a skip, and the row still reading `failed`. The
 * SIGNED-OUT case pins the counter alone, and deliberately: the skip is itself a
 * control call, so the same empty origin throws inside `resolveControlUrl`
 * before any fetch. That row cannot reach `dead` however the predicate
 * regresses, which also makes a skip-absence assertion there vacuous — it would
 * hold under the fix and under the regression alike.
 */

test("ISS-9793 AC: an offline control POST leaves retryCount unmoved and skips nothing", async () => {
  // Line 168: `fetch` rejected or the request's own timeout fired, i.e. the
  // laptop lost the network. No server judged these bytes — nothing was even
  // sent — so charging the row for it is the ISS-7730 laundering the allow-list
  // above exists to stop.
  const { posts, row } = await drivePersistentFailure({
    respond: () => Promise.reject(new Error("fetch failed")),
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(
    row?.retryCount,
    0,
    "an ordinary offline period must not spend the row's budget"
  );
  assert.equal(
    posts.filter((post) => post.path === SKIP_PATH).length,
    0,
    "and must not tell the cloud a healthy transcript was given up on"
  );
  assert.equal(row?.status, "failed", "the row stays truthfully failed");
  assert.ok(
    syncPlanPosts(posts).length <= 20,
    `a deferred lane polls on the staged schedule; got ${syncPlanPosts(posts).length}`
  );
});

test("ISS-9793 AC: an offline presigned upload leaves retryCount unmoved and skips nothing", async () => {
  // Line 228, the other half of the pair that makes this HIGH. Same condition on
  // the arm the row-ladder set was never reasoned about: a stalled uplink is not
  // the object's fault. Driven through the real `put`, so the error classified
  // here is the one production builds.
  const { posts, row } = await drivePersistentFailure({
    arm: "upload",
    respond: () => Promise.reject(new Error("socket hang up")),
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.ok(
    posts.some((post) => post.path === new URL(UPLOAD_URL).pathname),
    "the upload arm was actually exercised, not silently skipped"
  );
  assert.equal(
    row?.retryCount,
    0,
    "a stalled uplink must not spend the row's budget either"
  );
  assert.equal(
    posts.filter((post) => post.path === SKIP_PATH).length,
    0,
    "and must not reach an acked retries_exhausted skip"
  );
  assert.equal(row?.status, "failed");
});

test("ISS-9793: a response the schema rejects is version skew, not the row's fault", async () => {
  // Line 203, and the ruling most worth pinning because it reads
  // row-attributable and is not: a body this build cannot parse is a property of
  // the DEPLOYED SERVER, identical for every row on that endpoint. The 200 is
  // deliberate — the server answered, and answered unusably.
  const { posts, row } = await drivePersistentFailure({
    respond: () =>
      Promise.resolve(
        new Response(JSON.stringify({ unrecognized: "shape" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ),
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(
    row?.retryCount,
    0,
    "one skewed deploy must not retire the corpus it cannot describe"
  );
  assert.equal(
    posts.filter((post) => post.path === SKIP_PATH).length,
    0,
    "and must not record that retirement with the cloud"
  );
  assert.equal(row?.status, "failed");
});

test("ISS-9793: a signed-out desktop charges the row nothing", async () => {
  // Line 137, reached before any request exists — which is why `posts` holds no
  // sync-plan at all here. Signed-out is a property of the session, identical for
  // every row; spending a budget while the user is away is how a laptop comes
  // back to transcripts the cloud believes were legitimately abandoned.
  const { posts, row } = await drivePersistentFailure({
    apiOrigin: "",
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(
    syncPlanPosts(posts).length,
    0,
    "nothing is sent while signed out, so no server judged this row"
  );
  assert.equal(
    row?.retryCount,
    0,
    "and the row's budget is not spent on the user's absence"
  );
  assert.equal(row?.status, "failed");
});

test("ISS-9793: a REJECTED getAccessToken charges the row nothing", async () => {
  // whitlockk review. The signed-out case above hands `resolveControlUrl` a working
  // token and an empty origin, so it settles on the "not signed in" branch and
  // never enters the credential try/catch two lines above it. That catch is
  // separately wrapped — a locked keychain, a refresh that throws — and this
  // policy reclassifies it too, so a regression confined to it would pass every
  // other case in this file.
  const { posts, row } = await drivePersistentFailure({
    getAccessToken: () => Promise.reject(new Error("keychain locked")),
    retryAfter: null,
    windowMs: HALF_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(
    syncPlanPosts(posts).length,
    0,
    "the throw precedes the request, so no server judged this row either"
  );
  assert.equal(
    row?.retryCount,
    0,
    "a credential this desktop could not read is a property of the session, not of the bytes"
  );
  assert.equal(row?.status, "failed");
});

test("ISS-9793: past the stall ceiling the freeze HOLDS and the wall clock is the terminal", async () => {
  // marisolashgrove review. Every case above runs inside HALF_CEILING_MS, so all of
  // them pin the freeze with the wall-clock bound still slack — nothing pinned
  // the other side of the ceiling for this class. Two separable claims live
  // here, and the second is the one the "not lost" clause on
  // `isLaneWideHttpStatus` is about:
  //  - the freeze is NOT conditional on the ceiling — 48h of offline ticks still
  //    charge the row zero, so `retryCount` is not what retires it;
  //  - `deadEligible` goes true on wall clock alone, and because the SKIP
  //    endpoint here answers normally (only the request under test is offline),
  //    the ack lands and the row IS retired. A week-offline laptop returns with
  //    its stall clock already here, which is why "not lost" is stated with the
  //    ceiling clause rather than unqualified.
  const { posts, row } = await drivePersistentFailure({
    respond: () => Promise.reject(new Error("fetch failed")),
    retryAfter: null,
    windowMs: 2 * TRANSCRIPT_LANE_STALL_CEILING_MS,
    tickMs: 5 * 60_000,
  });

  assert.equal(
    row?.retryCount,
    0,
    "the freeze is not bounded by the ceiling: no offline tick ever spent the row's budget"
  );
  assert.equal(
    posts.filter((post) => post.path === SKIP_PATH).length,
    1,
    "the terminal is reached exactly once, and from the wall clock rather than the ladder"
  );
  assert.equal(
    row?.status,
    "dead",
    "which the cloud acked — so past the ceiling the row DOES reach dead"
  );
});
