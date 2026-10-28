/**
 * @file transcript-skip-reason-version-skew.test.ts
 * @description ISS-4820 item 4 — an API deployed BEFORE
 * `materialized_source_unavailable` existed rejects it with a 400 (the skip
 * write enum is closed on purpose). `tryEmitPermanentSkip` treated that as
 * merely unacknowledged, so the row went back on the retry ladder and resent
 * the unsupported value forever — pending until the server upgraded, with no
 * bound. Server-first deploy ordering covers the forward path but not a
 * rollback or a staged/mismatched environment.
 *
 * The fallback emits the pre-existing HARD `source_gone`, which every prior
 * server accepts, so the row settles instead of looping. These tests pin both
 * the new behavior AND that a transient failure is still just retried.
 *
 * ISS-9884 (review): the 400 fallback is only ONE of the two ways the reason
 * the cloud persists diverges from the one this desktop asked for. The other
 * is the server's own precedence rule (`resolveSkipReasonPrecedence`), which
 * refuses to let a recoverable reason overwrite a hard one already recorded.
 * Both come back the same way — on `permanentFailureReason` — so the cases
 * that pin reading the response rather than echoing the request live here too.
 *
 * Lives in its own file (not `transcript-sync-executor.test.ts`) per the
 * file-size rules.
 */
import assert from "node:assert/strict";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { test } from "vitest";
import {
  type DesktopTranscriptsClient,
  TranscriptSyncClientError,
} from "../src/main/transcript/desktop-transcripts-client.js";
import { createTranscriptSyncExecutor } from "../src/main/transcript-sync/transcript-sync-executor.js";
import { TranscriptSourceHarness } from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  fakeFsDeps,
  fingerprint,
  NOW,
  recordingStore,
} from "./helpers/transcript-sync-executor-fixtures.js";

const COMPUTE_TARGET = "ct-1";

/**
 * The subset of `TranscriptSkipRequest` these fakes read. `reason` carries the
 * real closed enum — the write schema is closed on purpose, and the response
 * echoes back only a KNOWN reason (an unrecognized label degrades to null), so
 * a bare `string` here would let the fake claim a shape the client cannot emit.
 */
type SkipAttempt = { sourceHarness: string; reason: TranscriptSkipReason };

/**
 * A client whose `skip` rejects with the given error for reasons in
 * `rejectReasons`, and acknowledges everything else — modelling an API build
 * whose closed write enum predates the newer reason.
 */
function skewedClient(
  rejectReasons: readonly string[],
  error: () => Error
): {
  client: DesktopTranscriptsClient;
  attempts: SkipAttempt[];
} {
  const attempts: SkipAttempt[] = [];
  const client = buildClient(attempts, rejectReasons, error);
  return { client, attempts };
}

function buildClient(
  attempts: SkipAttempt[],
  rejectReasons: readonly string[],
  error: () => Error
): DesktopTranscriptsClient {
  const client = {
    syncPlan: () =>
      Promise.resolve({
        mode: "noop" as const,
        syncedByteOffset: 0,
        storedEtag: null,
      }),
    uploadPut: () => Promise.resolve(),
    uploadPart: () => Promise.resolve(),
    complete: () =>
      Promise.resolve({
        status: TranscriptUploadStatus.Uploaded,
        syncedByteOffset: 0,
        storedEtag: null,
        sessionDetailId: null,
      }),
    skip: (request: SkipAttempt) => {
      attempts.push({
        sourceHarness: request.sourceHarness,
        reason: request.reason,
      });
      if (rejectReasons.includes(request.reason)) {
        return Promise.reject(error());
      }
      return Promise.resolve({
        status: TranscriptUploadStatus.Skipped,
        permanentFailureReason: request.reason,
        sessionDetailId: null,
      });
    },
  };
  return client;
}

function makeExecutor(client: DesktopTranscriptsClient) {
  return createTranscriptSyncExecutor({
    store: recordingStore(),
    client,
    getComputeTargetId: () => COMPUTE_TARGET,
    now: () => NOW,
    ...fakeFsDeps(null),
  });
}

const OPENCODE_FP = fingerprint({
  sourceHarness: TranscriptSourceHarness.OpenCode,
});

test("ISS-4820: a 400 rejecting the recoverable reason falls back to source_gone and SETTLES", async () => {
  const { client, attempts } = skewedClient(
    [TranscriptSkipReason.MaterializedSourceUnavailable],
    () => new TranscriptSyncClientError("/skip returned HTTP 400", 400)
  );

  const result = await makeExecutor(client).notifyPermanentSkip(
    OPENCODE_FP,
    TranscriptSkipReason.MaterializedSourceUnavailable,
    COMPUTE_TARGET
  );

  assert.deepEqual(
    result,
    {
      acked: true,
      status: TranscriptUploadStatus.Skipped,
      reason: TranscriptSkipReason.SourceGone,
    },
    "the row reaches an ACKNOWLEDGED terminal state instead of looping forever"
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.reason),
    [
      TranscriptSkipReason.MaterializedSourceUnavailable,
      TranscriptSkipReason.SourceGone,
    ],
    "the new reason is tried first, then exactly ONE fallback to the old hard reason"
  );
});

test("ISS-4820: the fallback is ONE-SHOT — a server rejecting BOTH reasons does not loop", async () => {
  const { client, attempts } = skewedClient(
    [
      TranscriptSkipReason.MaterializedSourceUnavailable,
      TranscriptSkipReason.SourceGone,
    ],
    () => new TranscriptSyncClientError("/skip returned HTTP 400", 400)
  );

  const result = await makeExecutor(client).notifyPermanentSkip(
    OPENCODE_FP,
    TranscriptSkipReason.MaterializedSourceUnavailable,
    COMPUTE_TARGET
  );

  assert.deepEqual(
    result,
    { acked: false },
    "an unacknowledged skip stays on the retry ladder (the pre-existing contract)"
  );
  assert.equal(
    attempts.length,
    2,
    "exactly two POSTs: the fallback reason is hard, so it cannot re-trigger the fallback"
  );
});

test("ISS-4820: a TRANSIENT failure is still just retried — no premature hard terminal", async () => {
  const { client, attempts } = skewedClient(
    [TranscriptSkipReason.MaterializedSourceUnavailable],
    () => new TranscriptSyncClientError("/skip returned HTTP 503", 503)
  );

  const result = await makeExecutor(client).notifyPermanentSkip(
    OPENCODE_FP,
    TranscriptSkipReason.MaterializedSourceUnavailable,
    COMPUTE_TARGET
  );

  assert.deepEqual(result, { acked: false });
  assert.deepEqual(
    attempts.map((attempt) => attempt.reason),
    [TranscriptSkipReason.MaterializedSourceUnavailable],
    "an outage must NOT be converted into source_gone — the source may still be there"
  );
});

test("ISS-4820: a non-status transport error is retried, never downgraded", async () => {
  const { client, attempts } = skewedClient(
    [TranscriptSkipReason.MaterializedSourceUnavailable],
    () => new TranscriptSyncClientError("access token unavailable")
  );

  const result = await makeExecutor(client).notifyPermanentSkip(
    OPENCODE_FP,
    TranscriptSkipReason.MaterializedSourceUnavailable,
    COMPUTE_TARGET
  );

  assert.deepEqual(result, { acked: false });
  assert.equal(attempts.length, 1, "no fallback without an explicit 400");
});

test("ISS-4820: a 400 on a HARD reason does NOT trigger a fallback (nothing to downgrade to)", async () => {
  const { client, attempts } = skewedClient(
    [TranscriptSkipReason.TooLarge],
    () => new TranscriptSyncClientError("/skip returned HTTP 400", 400)
  );

  const result = await makeExecutor(client).notifyPermanentSkip(
    fingerprint(),
    TranscriptSkipReason.TooLarge,
    COMPUTE_TARGET
  );

  assert.deepEqual(result, { acked: false });
  assert.deepEqual(
    attempts.map((attempt) => attempt.reason),
    [TranscriptSkipReason.TooLarge],
    "only a RECOVERABLE reason has a hard fallback; a hard one is already terminal"
  );
});

// ISS-9884 (PLN-1986 §3). C1 classified `environment_unavailable` RECOVERABLE,
// which widened the predicate this fallback keys on — so the single
// `source_gone` constant was already wired to it and simply unreachable while
// nothing emitted the reason. `source_gone` renders "this session's local
// transcript was removed before it could be archived" for a file sitting on
// disk, and it is HARD, so nothing recovers it: a worse lie than the one this
// ticket fixes. The fallback is per-reason now.
test("ISS-9884: a 400 on environment_unavailable falls back to retries_exhausted, NOT source_gone", async () => {
  const { client, attempts } = skewedClient(
    [TranscriptSkipReason.EnvironmentUnavailable],
    () => new TranscriptSyncClientError("/skip returned HTTP 400", 400)
  );

  const result = await makeExecutor(client).notifyPermanentSkip(
    fingerprint(),
    TranscriptSkipReason.EnvironmentUnavailable,
    COMPUTE_TARGET
  );

  // Assert the SECOND request's reason: a test that only checks the row
  // settled passes against the `source_gone` bug.
  assert.deepEqual(
    attempts.map((attempt) => attempt.reason),
    [
      TranscriptSkipReason.EnvironmentUnavailable,
      TranscriptSkipReason.RetriesExhausted,
    ],
    "the old server is told the label it already understands for this case"
  );
  assert.deepEqual(result, {
    acked: true,
    status: TranscriptUploadStatus.Skipped,
    // The reason the server RECORDED, so the local column matches the cloud's
    // and a skewed desktop does not render "Upload paused" for a row the cloud
    // settled `failedPermanent`.
    reason: TranscriptSkipReason.RetriesExhausted,
  });
});

test("ISS-9884: that fallback is one-shot — retries_exhausted is hard, so it cannot re-trigger", async () => {
  const { client, attempts } = skewedClient(
    [
      TranscriptSkipReason.EnvironmentUnavailable,
      TranscriptSkipReason.RetriesExhausted,
    ],
    () => new TranscriptSyncClientError("/skip returned HTTP 400", 400)
  );

  const result = await makeExecutor(client).notifyPermanentSkip(
    fingerprint(),
    TranscriptSkipReason.EnvironmentUnavailable,
    COMPUTE_TARGET
  );

  assert.deepEqual(result, { acked: false });
  assert.equal(attempts.length, 2);
});

// ISS-9884 (review) — THE SERVER'S ANSWER, NOT THE REQUEST.
//
// Every fake above echoes `permanentFailureReason: request.reason`, which is
// exactly why returning the request looked right: a double that answers the
// same thing regardless of the field under test proves nothing about it. The
// server substitutes for a second reason that has no 400 in it at all —
// `resolveSkipReasonPrecedence` keeps an already-recorded HARD reason rather
// than let a recoverable one overwrite it — and persisting the requested
// reason then renders "Upload paused" on the desktop for a row the cloud
// serves as `failedPermanent`, the cross-surface divergence the column exists
// to close.
function echoingClient(
  persisted: TranscriptSkipReason | null
): DesktopTranscriptsClient {
  const { client } = skewedClient([], () => new Error("unused"));
  return {
    ...client,
    skip: () =>
      Promise.resolve({
        status: TranscriptUploadStatus.Skipped,
        permanentFailureReason: persisted,
        sessionDetailId: null,
      }),
  };
}

test("ISS-9884: the reason the server PERSISTED wins over the one requested", async () => {
  // Precedence kept the hard `too_large` already on the row against this
  // lane-wide give-up. No 400 is involved: one POST, a different answer.
  const result = await makeExecutor(
    echoingClient(TranscriptSkipReason.TooLarge)
  ).notifyPermanentSkip(
    fingerprint(),
    TranscriptSkipReason.EnvironmentUnavailable,
    COMPUTE_TARGET
  );

  assert.deepEqual(result, {
    acked: true,
    status: TranscriptUploadStatus.Skipped,
    reason: TranscriptSkipReason.TooLarge,
  });
});

test("ISS-9884: a terminal this build cannot name persists null, not the request", async () => {
  // Precedence PRESERVES a label written by a newer peer; the response schema
  // degrades it to null on the way in. Substituting the requested recoverable
  // reason here would hand the desktop `failedTransient` for a row the cloud
  // reads as `failedPermanent` — the same divergence by another route. Null is
  // the honest answer and folds to the cloud's own conservative verdict.
  const result = await makeExecutor(echoingClient(null)).notifyPermanentSkip(
    fingerprint(),
    TranscriptSkipReason.EnvironmentUnavailable,
    COMPUTE_TARGET
  );

  assert.deepEqual(result, {
    acked: true,
    status: TranscriptUploadStatus.Skipped,
    reason: null,
  });
});

test("ISS-9884: a 503 on environment_unavailable is retried, never downgraded", async () => {
  // The lane being unreachable is the very condition that produced this
  // reason. Converting the outage into a hard terminal would settle a
  // presumed-present file as permanently lost.
  const { client, attempts } = skewedClient(
    [TranscriptSkipReason.EnvironmentUnavailable],
    () => new TranscriptSyncClientError("/skip returned HTTP 503", 503)
  );

  const result = await makeExecutor(client).notifyPermanentSkip(
    fingerprint(),
    TranscriptSkipReason.EnvironmentUnavailable,
    COMPUTE_TARGET
  );

  assert.deepEqual(result, { acked: false });
  assert.deepEqual(
    attempts.map((attempt) => attempt.reason),
    [TranscriptSkipReason.EnvironmentUnavailable]
  );
});
