/**
 * @file transcript-lane-wide-failure.test.ts
 * @description ISS-7097: the drain's split between a LANE-WIDE failure (the
 * cloud is down) and a ROW-ATTRIBUTABLE one (this file is wrong).
 *
 * The distinction is the whole point of the change, and it is invisible in the
 * settle payload unless asserted directly: both arms write a `failure` settle
 * with a backoff and a `lastError`, and only `retryCount` / `laneStalledSince`
 * say which bound is running. `sync/AGENTS.md` invariant 4 forbids a lane-wide
 * failure burning per-row budget, and invariant 5 forbids the resulting path
 * being unbounded — so both halves are pinned here.
 */
import assert from "node:assert/strict";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import {
  TranscriptForbiddenCode,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { test } from "vitest";
import type { SyncLaneBatchEvent } from "../src/main/agent-sync/sync-lane-cloud-health.js";
import { TranscriptSyncClientError } from "../src/main/transcript/desktop-transcripts-client.js";
import {
  classifyS3PutFailure,
  S3PutFailureClass,
} from "../src/main/transcript-sync/transcript-s3-put-classification.js";
import {
  TRANSCRIPT_LANE_STALL_CEILING_MS,
  TRANSCRIPT_LANE_STALL_RETRY_MS,
  type TranscriptFingerprint,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  fakeExecutor,
  fakeScheduler,
  fakeStore,
  fingerprint,
  makeService,
  NOW,
} from "./helpers/transcript-sync-fixtures.js";

function readyRow(
  overrides: Partial<TranscriptFingerprint> = {}
): TranscriptFingerprint {
  return fingerprint({
    externalSessionId: "sess-a",
    fileKey: "main",
    ...overrides,
  });
}

async function drainWith(
  error: unknown,
  row: TranscriptFingerprint = readyRow(),
  executorOverrides: {
    skipAck?: boolean;
    skipStatus?: TranscriptUploadStatus;
  } = {}
) {
  const store = fakeStore([row]);
  const { service } = makeService({
    store,
    scheduler: fakeScheduler().scheduler,
    executor: fakeExecutor({
      syncFile: () => Promise.reject(error),
      ...executorOverrides,
    }),
  });
  await service.drainOnce();
  return store;
}

/**
 * ISS-8599: the same drain, with the lane's batch-health seam wired so the
 * REPORTED cause can be asserted. Kept separate from {@link drainWith} so no
 * existing case silently acquires an emitter it was written without.
 */
async function drainCapturingBatchReason(
  error: unknown
): Promise<SyncReason[]> {
  const events: SyncLaneBatchEvent[] = [];
  const { service } = makeService({
    store: fakeStore([readyRow()]),
    scheduler: fakeScheduler().scheduler,
    executor: fakeExecutor({ syncFile: () => Promise.reject(error) }),
    emitSyncBatch: (event) => events.push(event),
  });
  await service.drainOnce();
  return events.map((event) => event.reason).filter((r) => r !== undefined);
}

// The REGRESSION LOCK. ISS-7097 was originally filed believing a 409 left the
// row stuck `uploading` and unreachable. It does not — it settles, and the row
// stays on the ladder — and that must keep being true, because the actual fix
// (freezing the budget for lane-wide failures) is one careless widening away
// from freezing it for a genuine stale upload too, which would strand rows the
// server is explicitly asking to re-plan.
test("ISS-7097: a 409 is row-attributable — it settles and advances the ladder", async () => {
  const store = await drainWith(
    new TranscriptSyncClientError(
      "/desktop/transcripts/complete returned HTTP 409",
      409
    )
  );

  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0].retryCount, 1, "the ladder must advance");
  assert.equal(
    store.failures[0].laneStalledSince,
    null,
    "a server that answered 409 is reachable, so no stall run is open"
  );
});

test("ISS-7097: a 503 does NOT burn the per-row retry budget", async () => {
  const store = await drainWith(
    new TranscriptSyncClientError("complete returned HTTP 503", 503)
  );

  assert.equal(store.failures.length, 1);
  assert.equal(
    store.failures[0].retryCount,
    0,
    "a cloud outage must not march a healthy row toward retries_exhausted"
  );
  assert.equal(
    store.failures[0].laneStalledSince,
    NOW,
    "the stall run opens now, so the wall-clock ceiling has an origin"
  );
  assert.equal(store.failures[0].dead, false);
});

// ISS-8689 LOCK. The two assertions above pin which BUDGET a lane-wide 503
// spends; nothing pinned WHICH DELAY CONSTANT it is rescheduled on, and that is
// exactly where ISS-8689 adds a second arm for a configuration-class 503.
//
// Read what this does and does not pin, because the two are easy to conflate.
// The expectation is DERIVED from `TRANSCRIPT_LANE_STALL_RETRY_MS`, so it is
// deliberately blind to that constant's VALUE — retuning 5min to anything else
// moves code and expectation together (verified: the mutant survives). The
// value is not unguarded, it is simply guarded elsewhere, by the session/
// transcript parity assertion in `agent-session-sync-lane-stall-fold.test.ts`.
//
// What this pins is the WIRING: that the lane-wide arm reads THIS constant and
// not another. Verified by mutation — pointing that arm at
// `TRANSCRIPT_LANE_STALL_CEILING_MS` reddens this case and nothing else. That
// is the failure mode ISS-8689 can introduce: a widening that routed EVERY
// lane-wide failure onto the longer configuration delay would otherwise ship
// green, silently slowing recovery from a real outage.
//
// Written before the change and kept UNMODIFIED through it — only this sentence
// is corrected. The delay is now a schedule rather than a flat cadence, and
// `TRANSCRIPT_LANE_STALL_RETRY_MS` is its FIRST RUNG; this row's stall run opens
// at `NOW`, so its age is zero and the first rung is what it must get.
test("ISS-8689: a lane-wide 503 reschedules on the first lane-stall rung", async () => {
  const store = await drainWith(
    new TranscriptSyncClientError("complete returned HTTP 503", 503)
  );

  assert.equal(
    store.failures[0].nextAttemptAt,
    new Date(Date.parse(NOW) + TRANSCRIPT_LANE_STALL_RETRY_MS).toISOString(),
    "a 503 with no Retry-After opens its stall run on the 5-minute floor"
  );
});

test("ISS-7097: a 429 is lane-wide too", async () => {
  const store = await drainWith(
    new TranscriptSyncClientError("complete returned HTTP 429", 429)
  );

  assert.equal(store.failures[0].retryCount, 0);
  assert.equal(store.failures[0].laneStalledSince, NOW);
});

// `sync/AGENTS.md` invariant 4 names this case outright: `unauthenticated`
// defers "without touching a counter" (FEA-3425). A signed-out user hits it on
// every row of their corpus at once, which is the definition of lane-wide.
test("ISS-7097: a 401 is lane-wide — auth loss is not the row's fault", async () => {
  const store = await drainWith(
    new TranscriptSyncClientError("complete returned HTTP 401", 401)
  );

  assert.equal(store.failures[0].retryCount, 0);
  assert.equal(store.failures[0].laneStalledSince, NOW);
});

// A BARE 403 stays row-attributable, and ISS-8599 deliberately did not change
// that. Only the REASON changed: it used to be that the route family answered
// 403 for both an ownership miss and an org-policy denial with nothing to tell
// them apart, and now it is that a 403 arriving with NO code is what an
// unpatched server has always sent. Widening this arm would change behaviour
// against every server in the fleet on the strength of no signal — and the
// cloud deploys first, so this arm is the whole skew story for old servers.
test("ISS-7097: a BARE 403 keeps the per-row ladder", async () => {
  const store = await drainWith(
    new TranscriptSyncClientError("complete returned HTTP 403", 403)
  );

  assert.equal(store.failures[0].retryCount, 1);
  assert.equal(store.failures[0].laneStalledSince, null);
});

// A row already stalling keeps its ORIGINAL start instant. If each failure
// restamped it, the ceiling would reset on every failure and never fire — the
// terminal path would be unreachable, which is exactly what invariant 5 forbids.
test("ISS-7097: an ongoing stall keeps its original start instant", async () => {
  const started = "2026-07-08T23:00:00.000Z";
  const store = await drainWith(
    new TranscriptSyncClientError("complete returned HTTP 500", 500),
    readyRow({ laneStalledSince: started })
  );

  assert.equal(store.failures[0].laneStalledSince, started);
  assert.equal(store.failures[0].dead, false);
});

test("ISS-7097: a stall past the ceiling still reaches a terminal state", async () => {
  const started = new Date(
    Date.parse(NOW) - TRANSCRIPT_LANE_STALL_CEILING_MS - 1
  ).toISOString();
  const store = await drainWith(
    new TranscriptSyncClientError("complete returned HTTP 503", 503),
    readyRow({ laneStalledSince: started }),
    { skipAck: true, skipStatus: TranscriptUploadStatus.Skipped }
  );

  assert.equal(
    store.failures[0].dead,
    true,
    "freezing retryCount removes the attempt bound, so the clock has to supply one"
  );
  // The drain still forwards the stall's origin; it is `settleUpdateData` that
  // drops it once the row goes terminal (asserted against a real store in
  // transcript-sync-store-recovery.test.ts).
  assert.equal(store.failures[0].laneStalledSince, started);
});

// A throw that is not a `TranscriptSyncClientError` at all never reached the
// cloud classification and still burns budget — the executor's own local
// failures (an unreadable source, a size cap) arrive this way and ARE the row's.
// ISS-9793 narrowed this case's scope, not its expectation: a status-less
// CLIENT error now freezes the counter instead, which is pinned by name in
// transcript-lane-stall-backoff.test.ts against the real client.
test("ISS-7097: a non-client throw still burns budget, as before", async () => {
  const store = await drainWith(new Error("socket hang up"));

  assert.equal(store.failures[0].retryCount, 1);
  assert.equal(store.failures[0].laneStalledSince, null);
});

// ISS-8599 (PRD-699 §6 item 8). The three cases below are the whole behavioural
// delta, and they are only separable because the SERVER now spells the two 403s
// apart — the bare-403 case above is what proves the split is additive rather
// than a reclassification of every 403 in the fleet.
//
// `sync/AGENTS.md` invariant 4's test is "reproducible from the persisted row",
// and neither coded 403 passes it: the row's bytes participate in neither
// verdict. So neither may spend `retryCount`, and both open the wall clock that
// invariant 5 requires as the replacement bound.

test("ISS-8599: a policy-denied 403 does NOT burn the per-row retry budget", async () => {
  const store = await drainWith(
    new TranscriptSyncClientError(
      "/desktop/transcripts/sync-plan returned HTTP 403",
      403,
      undefined,
      TranscriptForbiddenCode.PolicyDisabled
    )
  );

  assert.equal(store.failures.length, 1);
  assert.equal(
    store.failures[0].retryCount,
    0,
    "an org policy the desktop cannot influence must not march the corpus toward retries_exhausted"
  );
  assert.equal(
    store.failures[0].laneStalledSince,
    NOW,
    "the terminal path stays reachable on the wall clock instead"
  );
  assert.equal(store.failures[0].dead, false);
});

test("ISS-8599: an ownership 403 does NOT burn the per-row retry budget either", async () => {
  const store = await drainWith(
    new TranscriptSyncClientError(
      "/desktop/transcripts/sync-plan returned HTTP 403",
      403,
      undefined,
      TranscriptForbiddenCode.NotOwned
    )
  );

  assert.equal(store.failures[0].retryCount, 0);
  assert.equal(
    store.failures[0].laneStalledSince,
    NOW,
    "the transcript twin of the session lane's target_not_owned, which FEA-3425 already defers without touching a counter"
  );
});

// The forward half of the skew rule. A NEWER cloud sending a 403 code this build
// has never heard of must land on the unchanged bare-403 path, not on either arm
// above — the client resolver folds an unrecognized code to `undefined`, so by
// the time the drain sees it there is no code at all. Constructed here as
// `undefined` because that is exactly what `asTranscriptForbiddenCode` produces
// for such a body; the resolution itself is asserted over a real wire response
// in `desktop-transcripts-client-forbidden-code.test.ts`.
test("ISS-8599: a 403 whose code this build cannot name keeps the bare-403 ladder", async () => {
  const store = await drainWith(
    new TranscriptSyncClientError(
      "/desktop/transcripts/sync-plan returned HTTP 403 (code: transcript_some_future_denial)",
      403,
      undefined,
      undefined
    )
  );

  assert.equal(store.failures[0].retryCount, 1);
  assert.equal(store.failures[0].laneStalledSince, null);
});

// ISS-8599 (review-soul, class A). The two cases above pin what a coded 403
// COSTS; these pin what it is CALLED. Reading the discriminator for the retry
// budget and then folding the telemetry reason off the bare status would report
// a policy-denied org as a device holding a stale compute target — an assertion
// of the wrong cause, on the monitored lane, in the one place an operator looks.
// `retryCount`/`laneStalledSince` are identical for both codes, so nothing above
// this line can catch that collapse.
test("ISS-8599: a policy-denied 403 is REPORTED as feature_disabled, not target_not_owned", async () => {
  const reasons = await drainCapturingBatchReason(
    new TranscriptSyncClientError(
      "/desktop/transcripts/sync-plan returned HTTP 403",
      403,
      undefined,
      TranscriptForbiddenCode.PolicyDisabled
    )
  );

  assert.deepEqual(reasons, [SyncReason.FeatureDisabled]);
});

test("ISS-8599: an ownership 403 is still reported as target_not_owned", async () => {
  const reasons = await drainCapturingBatchReason(
    new TranscriptSyncClientError(
      "/desktop/transcripts/sync-plan returned HTTP 403",
      403,
      undefined,
      TranscriptForbiddenCode.NotOwned
    )
  );

  assert.deepEqual(reasons, [SyncReason.TargetNotOwned]);
});

// The uncoded path is unchanged, which is what makes the two above a refinement
// rather than a reclassification: an older server's bare 403 still folds off the
// status, exactly as it did before ISS-8599.
test("ISS-8599: a BARE 403 keeps the status-derived reason", async () => {
  const reasons = await drainCapturingBatchReason(
    new TranscriptSyncClientError("complete returned HTTP 403", 403)
  );

  assert.deepEqual(reasons, [SyncReason.TargetNotOwned]);
});

// ISS-8608 (PRD-699 Appendix A exception 4 / F6). The presigned UPLOAD arm is
// classified by this same `recordFailure`, and until now only by S3's bare
// status — so an expired presign and a socket that stalled mid-part spent the
// row budget and walked healthy transcripts to an acked `retries_exhausted`
// skip. These pin the refinement AND, just as importantly, its two gates: the
// ARM gate (a control-plane failure must not be re-read) and the STATUS gate
// (only the 400/403 Appendix A scopes the exception to).
//
// Constructed by hand here because what is under test is the DRAIN's decision.
// That the client actually produces these fields off a real S3 response — and
// off a real streaming PUT — is asserted in
// `desktop-transcripts-client-s3-error-code.test.ts`, which is the production
// wiring this file deliberately does not re-prove.

/** An S3 rejection as `put` mints it: status, the arm marker, and a code. */
function s3PutError(
  status: number,
  errorCode?: string
): TranscriptSyncClientError {
  return new TranscriptSyncClientError(
    `transcript fullPut returned HTTP ${status}`,
    status,
    undefined,
    undefined,
    { errorCode }
  );
}

test("ISS-8608: an expired presign does NOT burn the per-row retry budget", async () => {
  const store = await drainWith(s3PutError(403, "ExpiredToken"));

  assert.equal(store.failures.length, 1);
  assert.equal(
    store.failures[0].retryCount,
    0,
    "a URL that expired while a slow upload ran is a condition of the URL, not of these bytes"
  );
  assert.equal(
    store.failures[0].laneStalledSince,
    NOW,
    "and the terminal path stays reachable on the wall clock instead"
  );
  assert.equal(store.failures[0].dead, false);
});

test("ISS-8608: a mid-part socket stall does NOT burn the per-row retry budget", async () => {
  // The motivating failure. `400 IncompleteBody` on a multi-MB streamed part is
  // an ordinary slow uplink; Appendix A's "deterministic ~8 KiB control body"
  // reasoning for 400 never reached this arm.
  const store = await drainWith(s3PutError(400, "IncompleteBody"));

  assert.equal(store.failures[0].retryCount, 0);
  assert.equal(store.failures[0].laneStalledSince, NOW);
});

test("ISS-8608: an unreadable S3 body inherits the environmental default", async () => {
  // The malformed-XML acceptance criterion. No code at all must classify like a
  // code this build has never seen — never as the item's fault.
  const store = await drainWith(s3PutError(400, undefined));

  assert.equal(store.failures[0].retryCount, 0);
  assert.equal(store.failures[0].laneStalledSince, NOW);
});

test("ISS-8608: a code this build has never seen inherits the environmental default", async () => {
  const store = await drainWith(s3PutError(400, "SomeFutureS3Code"));

  assert.equal(store.failures[0].retryCount, 0);
});

test("ISS-8608: a prototype key in the code position is not a lookup hit", async () => {
  // The captured code is untrusted — it is parsed out of S3's body — and the
  // policy table is consulted with it. A plain-object lookup would answer
  // `__proto__` with `Object.prototype`, which is truthy and would classify this
  // as ITEM. Driven as a real string through the real drain, not as an object
  // literal key, which would create no own property and prove nothing.
  const store = await drainWith(s3PutError(400, "__proto__"));

  assert.equal(store.failures[0].retryCount, 0);
  assert.equal(store.failures[0].laneStalledSince, NOW);
});

// THE POSITIVE CONTROL for every case above. Without a code that still spends
// the budget, a classifier hardwired to "environmental" would pass all of them
// while the lane had stopped dead-lettering genuinely unsendable objects.
test("ISS-8608: an oversize object STILL advances the ladder", async () => {
  const store = await drainWith(s3PutError(400, "EntityTooLarge"));

  assert.equal(
    store.failures[0].retryCount,
    1,
    "an object S3 will never accept keeps the terminal door this refinement must not remove"
  );
  assert.equal(
    store.failures[0].laneStalledSince,
    null,
    "and opens no stall run, because the cloud is not what failed"
  );
});

// THE STATUS GATE. Appendix A's fourth exception is scoped to "S3 PUT 403/400",
// and 409 is its THIRD exception — `StaleUpload`, kept on the ladder so the next
// attempt re-plans. An ungated refinement would read this 409's environmental
// code and freeze the budget on the one status the standard most wants
// laddered. The combination is synthetic (a control-plane 409 cannot carry the
// upload marker, and S3's own PUT 409 is `OperationAborted`); it is driven
// anyway because the gate, not S3's catalogue, is what has to hold.
test("ISS-8608 STATUS GATE: a 409 still advances the ladder, even carrying an environmental code", async () => {
  const store = await drainWith(s3PutError(409, "RequestTimeout"));

  assert.equal(
    store.failures[0].retryCount,
    1,
    "the refinement declines a status it is not scoped to; it does not answer it"
  );
  assert.equal(store.failures[0].laneStalledSince, null);
});

test("ISS-8608 STATUS GATE: a 413 still advances the ladder", async () => {
  const store = await drainWith(s3PutError(413, "RequestTimeout"));

  assert.equal(store.failures[0].retryCount, 1);
});

// THE ARM GATE, and the whole reason the marker exists. `put` and `postControl`
// throw the same class, so without it "S3 answered 400 with an unreadable body"
// and "the control plane answered 400" are one value — and only the first may
// stop spending the budget.
test("ISS-8608 ARM GATE: a control-plane 400 still advances the ladder", async () => {
  const store = await drainWith(
    new TranscriptSyncClientError(
      "/desktop/transcripts/complete returned HTTP 400",
      400
    )
  );

  assert.equal(
    store.failures[0].retryCount,
    1,
    "a deterministic 8 KiB control body the server rejected is still the row's fault"
  );
  assert.equal(store.failures[0].laneStalledSince, null);
});

// ISS-8608: the budget and the MONITORED lane must name the same cause. Reading
// the discriminator for one and discarding it for the other is the collapse
// `transcriptFailureSyncReason` was split to remove — and S3 sends no
// `forbiddenCode`, so every S3 error reaches that function's uncoded branch.
test("ISS-8608: an expired presign is REPORTED as unauthenticated, not target_not_owned", async () => {
  const reasons = await drainCapturingBatchReason(
    s3PutError(403, "ExpiredToken")
  );

  assert.deepEqual(
    reasons,
    [SyncReason.Unauthenticated],
    "a credential/presign failure must not page as a device holding a stale compute target"
  );
});

test("ISS-8608: a mid-part stall is REPORTED as a transport timeout, not validation_failed", async () => {
  const reasons = await drainCapturingBatchReason(
    s3PutError(400, "IncompleteBody")
  );

  assert.deepEqual(
    reasons,
    [SyncReason.TransportTimeout],
    "a stalled socket must not be reported as a rejection of the payload"
  );
});

test("ISS-8608: an oversize object is REPORTED as locally oversized", async () => {
  const reasons = await drainCapturingBatchReason(
    s3PutError(400, "EntityTooLarge")
  );

  assert.deepEqual(reasons, [SyncReason.LocallyOversized]);
});

test("ISS-8608: a control-plane 400 keeps its status-derived reason", async () => {
  // The arm gate again, on the telemetry side: the reason fold must not fire for
  // an error that never came from an upload.
  const reasons = await drainCapturingBatchReason(
    new TranscriptSyncClientError("complete returned HTTP 400", 400)
  );

  assert.deepEqual(reasons, [SyncReason.ValidationFailed]);
});

// The label map exists to make an S3 credential outage legible on the monitored
// lane. It must never become a second class oracle: it maps a code to a NAME,
// and the class comes only from membership of the ITEM table. Asserted over the
// real classifier so the property is a fact about the code, not about this file.
//
// The seven codes are hand-copied because `S3_ENVIRONMENTAL_REASONS` is
// module-private, and exporting it purely to iterate here would widen a
// production surface for a test. Say the cost out loud rather than let the name
// imply otherwise: this guards DELETION and RE-CLASSIFICATION of the seven, and
// it cannot guard an eighth entry added without a case. The name says seven for
// that reason.
test("ISS-8608: the seven codes with a nicer reported name still classify ENVIRONMENTAL", () => {
  const namedEnvironmentalCodes = [
    "AccessDenied",
    "ExpiredToken",
    "InvalidAccessKeyId",
    "RequestTimeTooSkewed",
    "SignatureDoesNotMatch",
    "IncompleteBody",
    "RequestTimeout",
  ];
  for (const code of namedEnvironmentalCodes) {
    for (const status of [400, 403]) {
      assert.equal(
        classifyS3PutFailure(status, code),
        S3PutFailureClass.Environmental,
        `${code} at ${status}: a better telemetry label must not move a code's behaviour`
      );
    }
  }
});

// ISS-8608: the two codes the triage brief nominated for ITEM and this build
// deliberately does not carry. Pinned so the reasoning cannot be silently
// reverted: `InvalidArgument` is dominated by uniform request-construction skew
// (the presigner signs a concrete checksum and hoists a storage class, so a
// skew answers identically for EVERY row and charging it to the item would
// dead-letter the whole queue), and `InvalidDigest` describes a `Content-MD5`
// this client never sends.
test("ISS-8608: uniform request-skew codes are environmental, not the item's fault", async () => {
  for (const code of ["InvalidArgument", "InvalidDigest"]) {
    const store = await drainWith(s3PutError(400, code));
    assert.equal(
      store.failures[0].retryCount,
      0,
      `${code} would fail identically for every queued row, so it may not charge one`
    );
  }
});
