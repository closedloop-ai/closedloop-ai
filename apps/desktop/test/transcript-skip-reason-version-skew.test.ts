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
 * Lives in its own file (not the shrink-only grandfathered
 * `transcript-sync-executor.test.ts`) per the file-size rules.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TranscriptSkipReason,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
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
    { acked: true, status: TranscriptUploadStatus.Skipped },
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
