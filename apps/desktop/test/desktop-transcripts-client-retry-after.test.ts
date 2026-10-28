/**
 * @file desktop-transcripts-client-retry-after.test.ts
 * @description ISS-8689: the client reads the server's `Retry-After` header onto
 * the error it throws (PRD-699 F7) — on the control POSTs AND on the direct
 * presigned uploads, both of which reach the same staged lane-stall schedule.
 *
 * This suite exists because the parse being correct proves nothing on its own.
 * Constructing a `TranscriptSyncClientError` with a `retryAfterMs` by hand — as
 * every other lane test does — leaves the PRODUCTION wiring unasserted: delete
 * the header read from `postControl` and those tests all stay green while the
 * desktop is back to classifying by bare status code. So these drive the real
 * client over a stubbed `fetch` and assert what came off the wire.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createDesktopTranscriptsClient,
  TranscriptSyncClientError,
} from "../src/main/transcript/desktop-transcripts-client.js";
import { s3UploadError } from "./helpers/transcript-s3-upload-fixtures.js";

/** The S3 error code folded into the upload rejection message. */
const S3_SLOW_DOWN = /SlowDown/;

const SYNC_PLAN_REQUEST = {
  computeTargetId: "ct-1",
  externalSessionId: "sess-1",
  fileKey: "main",
  sourceHarness: "claude",
  sourcePathHash: "hash-1",
  sourceMtime: 1000,
  planEndOffset: 100,
} as const;

/**
 * A client whose every control POST answers 503 with the given headers. The
 * request never leaves the process; only the response shape is under test.
 */
function clientAnswering(headers: Record<string, string>) {
  return createDesktopTranscriptsClient({
    fetch: () =>
      Promise.resolve(
        new Response("upstream unavailable", { status: 503, headers })
      ) as unknown as ReturnType<typeof fetch>,
    getAccessToken: () => Promise.resolve("token"),
    getApiOrigin: () => "https://api.test",
  });
}

async function syncPlanError(
  headers: Record<string, string>
): Promise<TranscriptSyncClientError> {
  try {
    await clientAnswering(headers).syncPlan(
      SYNC_PLAN_REQUEST as unknown as Parameters<
        ReturnType<typeof createDesktopTranscriptsClient>["syncPlan"]
      >[0]
    );
  } catch (error) {
    if (error instanceof TranscriptSyncClientError) {
      return error;
    }
    throw new Error(
      `the control plane must throw its own typed error, got ${String(error)}`
    );
  }
  throw new Error("syncPlan resolved on a 503");
}

test("ISS-8689: a 503 carrying Retry-After surfaces it on the thrown error", async () => {
  const error = await syncPlanError({ "Retry-After": "3600" });

  assert.equal(
    error.status,
    503,
    "the status is still the class discriminator"
  );
  assert.equal(
    error.retryAfterMs,
    3_600_000,
    "and the header is what tells a configuration outage from a transient one"
  );
});

test("ISS-8689: a short Retry-After surfaces too, so the transient case is distinguishable", async () => {
  // Both cases must carry a value or the lane cannot tell them apart — an
  // implementation that only forwarded "long" headers would collapse the two.
  const error = await syncPlanError({ "Retry-After": "60" });

  assert.equal(error.retryAfterMs, 60_000);
});

test("ISS-8689: an OLD server sending no Retry-After leaves it undefined", async () => {
  // The version-skew acceptance criterion, at the one seam that can violate it.
  // `undefined` is what routes the lane back to its own staged schedule; a
  // fabricated default here would be a stand-down inferred from an ABSENT
  // field, which the ticket forbids outright.
  const error = await syncPlanError({});

  assert.equal(error.retryAfterMs, undefined);
  assert.equal(error.status, 503, "the pre-existing signal is unaffected");
});

test("ISS-8689: an unparseable Retry-After is dropped, not guessed at", async () => {
  const error = await syncPlanError({ "Retry-After": "soon" });

  assert.equal(error.retryAfterMs, undefined);
});

test("ISS-8689: the header read does not disturb the pre-existing 4xx path", async () => {
  // The lane-wide/row-attributable split is decided on `status`, and a 409 must
  // keep arriving exactly as it did — a header read that threw, or that
  // rewrote the message, would silently re-route stale-plan errors.
  const client = createDesktopTranscriptsClient({
    fetch: () =>
      Promise.resolve(
        new Response("stale", { status: 409 })
      ) as unknown as ReturnType<typeof fetch>,
    getAccessToken: () => Promise.resolve("token"),
    getApiOrigin: () => "https://api.test",
  });

  await assert.rejects(
    () =>
      client.syncPlan(
        SYNC_PLAN_REQUEST as unknown as Parameters<typeof client.syncPlan>[0]
      ),
    (error: unknown) =>
      error instanceof TranscriptSyncClientError &&
      error.status === 409 &&
      error.retryAfterMs === undefined &&
      error.message.includes("/desktop/transcripts/sync-plan returned HTTP 409")
  );
});

test("a control-plane 401 invalidates the exact rejected session token", async () => {
  const invalidations: string[] = [];
  const client = createDesktopTranscriptsClient({
    fetch: () =>
      Promise.resolve(
        new Response("unauthorized", { status: 401 })
      ) as unknown as ReturnType<typeof fetch>,
    getAccessToken: () => Promise.resolve("transcript-token"),
    getApiOrigin: () => "https://api.test",
    onUnauthorized: (rejectedToken) => {
      invalidations.push(rejectedToken);
    },
  });

  await assert.rejects(
    () =>
      client.syncPlan(
        SYNC_PLAN_REQUEST as unknown as Parameters<typeof client.syncPlan>[0]
      ),
    (error: unknown) =>
      error instanceof TranscriptSyncClientError && error.status === 401
  );

  assert.deepEqual(invalidations, ["transcript-token"]);
});

// ISS-8689: `uploadPut`/`uploadPart` bypass `postControl` entirely — they PUT
// straight to S3 — but their rejections land on the SAME lane-wide arm, since
// `isLaneWideHttpStatus` admits 429 and every 5xx whatever produced them. So a
// header read wired only into the control plane leaves the upload half retrying
// ahead of a minimum the storage layer did state, and no control-plane test can
// see it: these two methods are the whole uncovered surface.
//
// ISS-8608 needed the same boundary for the S3 `<Code>`, so the driver this file
// introduced now lives in `helpers/transcript-s3-upload-fixtures.ts` and both
// suites share it. Its defaults are the fixture this file always used — a 503
// carrying `<Error><Code>SlowDown</Code></Error>` through `uploadPut`.
const uploadError = (headers: Record<string, string>) =>
  s3UploadError({ headers });

test("ISS-8689: a direct-upload 503 carries Retry-After like a control POST does", async () => {
  const error = await uploadError({ "Retry-After": "3600" });

  assert.equal(error.status, 503, "the status still routes the failure class");
  assert.equal(
    error.retryAfterMs,
    3_600_000,
    "the upload half honors the same minimum the control half does"
  );
  assert.match(
    error.message,
    S3_SLOW_DOWN,
    "and the S3 body snippet is still folded in — the header read replaces nothing"
  );
});

test("ISS-8689: a direct upload with no Retry-After leaves the schedule to the lane", async () => {
  // S3 usually sends no header at all. Absence must stay absence here for the
  // same reason it must on the control plane: it is what routes the row back to
  // the staged schedule instead of a stand-down inferred from a missing field.
  const error = await uploadError({});

  assert.equal(error.retryAfterMs, undefined);
  assert.equal(error.status, 503);
});
