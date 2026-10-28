/**
 * @file desktop-transcripts-client-forbidden-code.test.ts
 * @description ISS-8599 (PRD-699 §6 item 8): the client resolves the server's
 * machine-readable 403 `code` onto the error it throws, so the drain can tell a
 * compute-target ownership miss from an org-policy denial.
 *
 * This suite drives the REAL client over a stubbed `fetch`, for the reason its
 * sibling `desktop-transcripts-client-retry-after.test.ts` gives: constructing a
 * `TranscriptSyncClientError` with a `forbiddenCode` by hand — which the drain
 * tests do — leaves the production wiring unasserted. Delete the body read from
 * `postControl` and every one of those stays green while the desktop is back to
 * classifying a policy denial as the file's own fault.
 *
 * The expected code STRINGS are hand-written literals here, deliberately and
 * against the repo's usual import-the-constant rule. These are a cross-process
 * wire contract with a cloud that deploys separately: reading the expectation
 * off `TranscriptForbiddenCode` — the symbol under test — would keep this suite
 * green through a rename that silently stops matching what the deployed API
 * sends. The server half is pinned to the same literals in
 * `apps/api/app/desktop/transcripts/transcript-route-helpers.test.ts`, and the
 * two files are the contract.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createDesktopTranscriptsClient,
  TranscriptSyncClientError,
} from "../src/main/transcript/desktop-transcripts-client.js";

/** The wire spelling of an ownership-miss 403. Pinned, not imported — see the header. */
const WIRE_NOT_OWNED = "transcript_target_not_owned";
/** The wire spelling of an org-policy 403. Pinned, not imported — see the header. */
const WIRE_POLICY_DISABLED = "transcript_policy_disabled";
/** A denial class this build has never heard of — the forward-skew fixture. */
const WIRE_FUTURE_CODE = "transcript_some_future_denial";
/** Matches {@link WIRE_FUTURE_CODE} surviving into the error message. */
const FUTURE_CODE_PATTERN = /transcript_some_future_denial/;
/** Matches the readable remnant of the control-character fixture. */
const SANITIZED_REMNANT_PATTERN = /evil/;

const SYNC_PLAN_REQUEST = {
  computeTargetId: "ct-1",
  externalSessionId: "sess-1",
  fileKey: "main",
  sourceHarness: "claude",
  sourcePathHash: "hash-1",
  sourceMtime: 1000,
  planEndOffset: 100,
};

/** Drive `syncPlan` against one canned response and return the thrown error. */
async function syncPlanErrorFor(
  response: Response
): Promise<TranscriptSyncClientError> {
  const client = createDesktopTranscriptsClient({
    fetch: () =>
      Promise.resolve(response) as unknown as ReturnType<typeof fetch>,
    getAccessToken: () => Promise.resolve("token"),
    getApiOrigin: () => "https://api.test",
  });
  try {
    await client.syncPlan(
      SYNC_PLAN_REQUEST as unknown as Parameters<
        ReturnType<typeof createDesktopTranscriptsClient>["syncPlan"]
      >[0]
    );
  } catch (error) {
    if (error instanceof TranscriptSyncClientError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected syncPlan to reject");
}

/** The `ApiResult` failure envelope `failure(message, { code })` produces. */
function forbiddenBody(code?: string): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: "Forbidden",
      ...(code && { code }),
    }),
    { status: 403, headers: { "Content-Type": "application/json" } }
  );
}

test("ISS-8599: a policy-denied 403 resolves to the PolicyDisabled code", async () => {
  const error = await syncPlanErrorFor(forbiddenBody(WIRE_POLICY_DISABLED));

  assert.equal(error.status, 403);
  assert.equal(error.forbiddenCode, WIRE_POLICY_DISABLED);
});

test("ISS-8599: an ownership 403 resolves to the NotOwned code", async () => {
  const error = await syncPlanErrorFor(forbiddenBody(WIRE_NOT_OWNED));

  assert.equal(error.status, 403);
  assert.equal(error.forbiddenCode, WIRE_NOT_OWNED);
});

// The two codes must not collapse into each other. Asserting each in isolation
// would stay green under a client that answered the same code for both bodies.
test("ISS-8599: the two 403 codes are distinguishable, not one value", async () => {
  const policy = await syncPlanErrorFor(forbiddenBody(WIRE_POLICY_DISABLED));
  const ownership = await syncPlanErrorFor(forbiddenBody(WIRE_NOT_OWNED));

  assert.notEqual(policy.forbiddenCode, ownership.forbiddenCode);
});

// SKEW, backwards: the cloud deploys first, but an installed Desktop still talks
// to whatever is in front of it, and a 403 from an older API — or from a proxy
// that never reached the API — carries no envelope at all.
test("ISS-8599: a 403 from a server that sends no code stays uncoded", async () => {
  const error = await syncPlanErrorFor(
    new Response("Forbidden", { status: 403 })
  );

  assert.equal(error.status, 403);
  assert.equal(error.forbiddenCode, undefined);
});

test("ISS-8599: a 403 whose envelope omits `code` stays uncoded", async () => {
  const error = await syncPlanErrorFor(forbiddenBody());

  assert.equal(error.forbiddenCode, undefined);
});

// SKEW, forwards: a NEWER cloud that has added a third denial class. The code is
// unrecognized, so it may not be acted on — but it must still be VISIBLE, or an
// operator cannot tell that a class this build cannot classify has started
// arriving (the shape ISS-8595 settled for the session lane's unknown ack).
test("ISS-8599: an unrecognized code is not acted on, but is named in the message", async () => {
  const error = await syncPlanErrorFor(forbiddenBody(WIRE_FUTURE_CODE));

  assert.equal(
    error.forbiddenCode,
    undefined,
    "a class this build cannot name must fall back to the bare-403 classification"
  );
  assert.match(error.message, FUTURE_CODE_PATTERN);
});

// The code is untrusted server text on its way to the gateway console sink, so
// it goes through the same C0/DEL strip the session lane applies to an
// unrecognized ack reason. A raw newline here would forge a second log line.
test("ISS-8599: an unrecognized code is stripped of control characters", async () => {
  const error = await syncPlanErrorFor(
    forbiddenBody("evil\n2026-01-01 FATAL forged\u001B[31m")
  );

  assert.equal(error.forbiddenCode, undefined);
  assert.ok(
    !(error.message.includes("\n") || error.message.includes("\u001B")),
    "a newline or ESC must never survive into the log line"
  );
  assert.match(error.message, SANITIZED_REMNANT_PATTERN);
});

// The body read is scoped to 403 alone. A non-403 that happens to carry a `code`
// must not acquire one — widening the read would let an unrelated envelope
// (a 400 validation failure, a proxy's JSON error page) steer the lane-wide
// classifier.
test("ISS-8599: a coded non-403 acquires no forbiddenCode", async () => {
  const error = await syncPlanErrorFor(
    new Response(
      JSON.stringify({
        success: false,
        error: "Bad",
        code: WIRE_POLICY_DISABLED,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  );

  assert.equal(error.status, 400);
  assert.equal(error.forbiddenCode, undefined);
});

// TRUST BOUNDARY (whitlockk review, PR #6762). A 403 need not have come from our
// API at all: a proxy, WAF or corporate gateway answers one with a body of its
// own, and this `code` is not a log line — it is the input to a LANE-WIDE
// denial that stands the whole corpus down for up to 24 hours. So a body that
// carries `code` without being our failure envelope must read as a bare 403.
test("ISS-8599: a proxy 403 carrying a bare `code` is not treated as a denial", async () => {
  const error = await syncPlanErrorFor(
    new Response(JSON.stringify({ code: WIRE_POLICY_DISABLED }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
  );

  assert.equal(error.status, 403);
  assert.equal(
    error.forbiddenCode,
    undefined,
    "only OUR failure envelope may freeze the lane's retry budget"
  );
});

// The same body with `success: true` is not a failure envelope either — an
// intermediary that mimics the field names still has to say `success: false`,
// which is the one thing `failure()` always emits.
test("ISS-8599: a 403 body claiming success carries no denial code", async () => {
  const error = await syncPlanErrorFor(
    new Response(
      JSON.stringify({ success: true, code: WIRE_NOT_OWNED, error: "Nope" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    )
  );

  assert.equal(error.forbiddenCode, undefined);
});
