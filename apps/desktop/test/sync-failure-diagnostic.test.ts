import assert from "node:assert/strict";
import {
  SyncLane,
  SyncPayloadShaping,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { test } from "vitest";
import {
  budgetForSyncReason,
  buildSyncFailureDiagnostic,
  highestFailureCount,
  MAX_DIAGNOSTIC_SESSION_IDS,
  reportSyncAttemptFailure,
  resolveFoldedAttempt,
  resolveSyncPayloadShaping,
  SYNC_FAILURE_DIAGNOSTIC_PREFIX,
  SYNC_FAILURE_DIAGNOSTIC_SCHEMA,
  type SyncFailureDiagnostic,
} from "../src/main/agent-sync/sync-failure-diagnostic.js";
import {
  type DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../src/main/telemetry/app-otel-runtime.js";

const BATCH_ID = "d4b6b0a2-6a3e-4f9c-8b1d-2c3e4f5a6b7c";

/**
 * The COMPLETE field set of a diagnostic record, as a keys-covered guard.
 *
 * This is the compile-time half of the no-content-leak contract: a new field on
 * {@link SyncFailureDiagnostic} fails `tsc` right here until someone writes it
 * down, which is the moment to ask whether it can carry content. The runtime
 * half is `assertNoContentLeak` below, which checks the VALUES.
 */
const DIAGNOSTIC_FIELDS: Record<keyof SyncFailureDiagnostic, true> = {
  schema: true,
  batchId: true,
  lane: true,
  outcome: true,
  reason: true,
  payloadBytes: true,
  sessionCount: true,
  sessionIds: true,
  sessionIdsOmitted: true,
  payloadShaping: true,
  chunkPosition: true,
  tilingStrippedSessionCount: true,
  attempt: true,
  latencyMs: true,
  organizationId: true,
};

/**
 * Fail if any string the record carries is something other than an id the
 * caller supplied or a member of a closed vocabulary.
 *
 * Key coverage alone would pass a record whose `reason` field had been widened
 * to a raw server error message, so this walks the VALUES: a transcript, a
 * prompt, a file path, or a repository name reaching any field has nowhere to
 * hide because it matches nothing in `allowedStrings`.
 */
function contentLeaks(
  record: SyncFailureDiagnostic,
  allowedStrings: Iterable<string>
): string[] {
  const allowed = new Set<string>(allowedStrings);
  const leaked: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (!allowed.has(value)) {
        leaked.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        visit(item);
      }
    }
  };
  visit(record);
  return leaked;
}

function baseInput() {
  return {
    batchId: BATCH_ID,
    lane: SyncLane.SessionMetadata,
    outcome: DesktopSyncBatchOutcome.Failure,
    reason: SyncReason.IngestionFailed,
    payloadBytes: 4096,
    sessionIds: ["session-a", "session-b"],
    payloadShaping: SyncPayloadShaping.Whole,
  } as const;
}

test("a failure diagnostic carries only ids, sizes, and closed enum members", () => {
  const record = buildSyncFailureDiagnostic({
    ...baseInput(),
    attempt: 2,
    latencyMs: 812,
    organizationId: "org-1",
  });

  assert.deepEqual(
    Object.keys(record).filter((key) => !(key in DIAGNOSTIC_FIELDS)),
    [],
    "the record grew a field outside the declared contract"
  );
  assert.deepEqual(
    contentLeaks(record, [
      SYNC_FAILURE_DIAGNOSTIC_SCHEMA,
      BATCH_ID,
      SyncLane.SessionMetadata,
      DesktopSyncBatchOutcome.Failure,
      SyncReason.IngestionFailed,
      SyncPayloadShaping.Whole,
      "session-a",
      "session-b",
      "org-1",
    ]),
    [],
    "a string reached the record that is neither a supplied id nor a closed enum member"
  );
});

test("the failing session ids are recorded so a poisoned record is identifiable", () => {
  const record = buildSyncFailureDiagnostic({
    ...baseInput(),
    sessionIds: ["poisoned-session", "healthy-neighbour"],
  });

  assert.deepEqual(record.sessionIds, [
    "poisoned-session",
    "healthy-neighbour",
  ]);
  assert.equal(record.sessionCount, 2);
  assert.equal(record.batchId, BATCH_ID);
});

test("the id list is capped and the dropped remainder is reported", () => {
  const ids = Array.from(
    { length: MAX_DIAGNOSTIC_SESSION_IDS + 7 },
    (_unused, index) => `session-${index}`
  );

  const record = buildSyncFailureDiagnostic({
    ...baseInput(),
    sessionIds: ids,
  });

  assert.equal(record.sessionIds.length, MAX_DIAGNOSTIC_SESSION_IDS);
  assert.equal(record.sessionIdsOmitted, 7);
  assert.equal(
    record.sessionCount,
    ids.length,
    "the count must report the whole batch, not the truncated id list"
  );
});

test("no remainder is reported when the cap dropped nothing", () => {
  const record = buildSyncFailureDiagnostic(baseInput());

  assert.equal(
    "sessionIdsOmitted" in record,
    false,
    "the remainder tally must be absent unless ids were actually dropped"
  );
});

test("a non-finite or negative payload size is never recorded as measured", () => {
  const record = buildSyncFailureDiagnostic({
    ...baseInput(),
    payloadBytes: Number.NaN,
    latencyMs: -5,
  });

  assert.equal(record.payloadBytes, 0);
  assert.equal(record.latencyMs, 0);
});

test("the attempt number is the highest consecutive-failure count in the batch", () => {
  const ingestionFailures = new Map([
    ["session-a", 2],
    ["session-b", 4],
  ]);

  assert.equal(
    highestFailureCount(["session-a", "session-b"], ingestionFailures),
    4
  );
  assert.equal(
    highestFailureCount(["session-c"], ingestionFailures),
    0,
    "an id the budget has not touched contributes nothing"
  );
  assert.equal(
    highestFailureCount(["session-a"], null),
    0,
    "a reason that charges no budget has no count to report"
  );
});

test("each reason resolves to the budget it actually charges", () => {
  const budgets = {
    ackTimeout: new Map([["s", 1]]),
    transportTimeout: new Map([["s", 2]]),
    rateLimited: new Map([["s", 3]]),
    ingestionFailed: new Map([["s", 4]]),
    validationFailed: new Map([["s", 5]]),
    ackOmitted: new Map([["s", 6]]),
    transportError: new Map([["s", 7]]),
  };

  assert.equal(
    highestFailureCount(
      ["s"],
      budgetForSyncReason(SyncReason.TransportTimeout, budgets)
    ),
    2,
    "transport_timeout charges TransportTimeoutBudget's own counter, not the service's"
  );
  assert.equal(
    highestFailureCount(
      ["s"],
      budgetForSyncReason(SyncReason.AckTimeout, budgets)
    ),
    1
  );
  assert.equal(
    highestFailureCount(
      ["s"],
      budgetForSyncReason(SyncReason.IngestionFailed, budgets)
    ),
    4
  );
  assert.equal(
    highestFailureCount(
      ["s"],
      budgetForSyncReason(SyncReason.TransportError, budgets)
    ),
    7
  );
});

test("a reason that burns no budget reports no attempt, whatever else the row owes", () => {
  const budgets = {
    ackTimeout: new Map<string, number>(),
    transportTimeout: new Map<string, number>(),
    rateLimited: new Map([["s", 9]]),
    // The row already owes an unrelated charge from an earlier failure class.
    ingestionFailed: new Map([["s", 4]]),
    validationFailed: new Map<string, number>(),
    ackOmitted: new Map<string, number>(),
    transportError: new Map<string, number>(),
  };

  for (const reason of [
    SyncReason.Unauthenticated,
    SyncReason.TargetNotOwned,
    SyncReason.FeatureDisabled,
    SyncReason.TransportUnavailable,
  ]) {
    assert.equal(
      budgetForSyncReason(reason, budgets),
      null,
      `${reason} defers with budgets intact and must charge nothing`
    );
    assert.equal(
      highestFailureCount(["s"], budgetForSyncReason(reason, budgets)),
      0,
      `${reason} must not inherit an unrelated class's count`
    );
  }
});

test("an exhausting fold reports the attempt count it consumed and cleared", () => {
  assert.equal(
    resolveFoldedAttempt({
      before: 4,
      after: 0,
      deadLetteredThisAttempt: true,
    }),
    5,
    "the fold cleared the counter it just spent; the record must still say 5"
  );
  assert.equal(
    resolveFoldedAttempt({
      before: 2,
      after: 3,
      deadLetteredThisAttempt: false,
    }),
    3,
    "a deferred fold already wrote the incremented count"
  );
  assert.equal(
    resolveFoldedAttempt({
      before: 0,
      after: 2,
      deadLetteredThisAttempt: true,
    }),
    2,
    "a sibling that merely deferred must not under-report a dead-lettered batch"
  );
});

test("the attempt number is omitted when no retry budget was burned", () => {
  assert.equal(
    resolveFoldedAttempt({
      before: 0,
      after: 0,
      deadLetteredThisAttempt: false,
    }),
    undefined,
    "a class that defers with budgets intact has no attempt count to report"
  );

  const record = buildSyncFailureDiagnostic({
    ...baseInput(),
    reason: SyncReason.Unauthenticated,
    attempt: undefined,
  });
  assert.equal(
    "attempt" in record,
    false,
    "an unmeasured attempt must be absent, never a fabricated 1"
  );
});

test("payload shaping distinguishes a chunk tail from an abandoned sequence", () => {
  assert.equal(
    resolveSyncPayloadShaping({
      drainingPendingChunkTail: false,
      hasPinnedChunkTail: false,
      chunkTailDiscarded: false,
      activityTilingStripped: false,
    }),
    SyncPayloadShaping.Whole
  );
  assert.equal(
    resolveSyncPayloadShaping({
      drainingPendingChunkTail: false,
      hasPinnedChunkTail: true,
      chunkTailDiscarded: false,
      activityTilingStripped: false,
    }),
    SyncPayloadShaping.ChunkedHead
  );
  assert.equal(
    resolveSyncPayloadShaping({
      drainingPendingChunkTail: true,
      hasPinnedChunkTail: true,
      chunkTailDiscarded: false,
      activityTilingStripped: false,
    }),
    SyncPayloadShaping.ChunkedTail
  );
  assert.equal(
    resolveSyncPayloadShaping({
      drainingPendingChunkTail: true,
      hasPinnedChunkTail: false,
      chunkTailDiscarded: true,
      activityTilingStripped: false,
    }),
    SyncPayloadShaping.ChunkTailDiscarded,
    "a failure that threw away the pinned remainder is a different incident"
  );
});

test("reporting one attempt writes the durable record and never puts ids on the wire", () => {
  const durable: string[] = [];
  const emitted: DesktopSyncBatchEventInput[] = [];

  reportSyncAttemptFailure(
    {
      emitTelemetry: (event) => emitted.push(event),
      writeDurableRecord: (line) => durable.push(line),
    },
    {
      ...baseInput(),
      sessionIds: ["poisoned-session"],
      attempt: 3,
      latencyMs: 44,
      organizationId: "org-1",
    }
  );

  assert.equal(durable.length, 1);
  assert.equal(emitted.length, 1);
  assert.match(durable[0], new RegExp(`^${SYNC_FAILURE_DIAGNOSTIC_PREFIX}`));
  assert.equal(
    JSON.stringify(emitted[0]).includes("poisoned-session"),
    false,
    "a session id must never reach the telemetry seam"
  );
  assert.equal(
    JSON.stringify(emitted[0]).includes("org-1"),
    false,
    "org identity is local-only and must never reach the telemetry seam"
  );
  assert.equal(
    emitted[0].batchId,
    BATCH_ID,
    "the join key must reach the wire"
  );
  assert.equal(emitted[0].sessionCount, 1);
  assert.equal(emitted[0].attempt, 3);
  assert.equal(emitted[0].payloadShaping, SyncPayloadShaping.Whole);
});

test("the durable record is written even when no telemetry seam is wired", () => {
  const durable: string[] = [];

  reportSyncAttemptFailure(
    { writeDurableRecord: (line) => durable.push(line) },
    baseInput()
  );

  assert.equal(
    durable.length,
    1,
    "the record that survives a failing cloud must not depend on the cloud seam"
  );
});

test("ISS-7265: the strip count reaches the span even when the shaping value masks it", () => {
  // `chunk_tail_discarded` outranks `tiling_stripped` on the one-slot attribute,
  // so on this branch the count is the span's ONLY degradation signal. Without
  // it a strip that co-occurred with an abandoned sequence would reach the
  // dashboard indistinguishable from an undegraded abandoned sequence.
  const emitted: DesktopSyncBatchEventInput[] = [];

  reportSyncAttemptFailure(
    {
      emitTelemetry: (event) => emitted.push(event),
      writeDurableRecord: () => undefined,
    },
    {
      ...baseInput(),
      sessionIds: ["masked-session"],
      payloadShaping: SyncPayloadShaping.ChunkTailDiscarded,
      tilingStrippedSessionCount: 2,
    }
  );

  assert.equal(emitted.length, 1);
  assert.equal(
    emitted[0].payloadShaping,
    SyncPayloadShaping.ChunkTailDiscarded,
    "precondition: the shaping slot is reporting the abandoned sequence"
  );
  assert.equal(emitted[0].tilingStrippedSessionCount, 2);
});

test("ISS-7265: an undegraded attempt puts no strip count on the span", () => {
  const emitted: DesktopSyncBatchEventInput[] = [];

  reportSyncAttemptFailure(
    {
      emitTelemetry: (event) => emitted.push(event),
      writeDurableRecord: () => undefined,
    },
    { ...baseInput(), sessionIds: ["clean-session"] }
  );

  assert.equal(
    "tilingStrippedSessionCount" in emitted[0],
    false,
    "a 0 on every healthy span would drown the exception it exists to surface"
  );
});

// ---------------------------------------------------------------------------
// ISS-7985 item 6: budgetForSyncReason's prototype-pollution guard — an
// unknown reason returns null and does not reach Object.prototype.
// ---------------------------------------------------------------------------

test("ISS-7985: budgetForSyncReason returns null for an unknown reason (Object.hasOwn guard)", () => {
  const budgets = {
    ackTimeout: new Map<string, number>(),
    transportTimeout: new Map<string, number>(),
    rateLimited: new Map<string, number>(),
    ingestionFailed: new Map<string, number>(),
    validationFailed: new Map<string, number>(),
    ackOmitted: new Map<string, number>(),
    transportError: new Map<string, number>(),
  };

  assert.equal(
    budgetForSyncReason("quota_exceeded" as SyncReason, budgets),
    null,
    "a reason from a version-skewed cloud charges nothing"
  );
  assert.equal(
    budgetForSyncReason("__proto__" as SyncReason, budgets),
    null,
    "__proto__ is stopped by Object.hasOwn, not inherited from Object.prototype"
  );
  assert.equal(
    budgetForSyncReason("constructor" as SyncReason, budgets),
    null,
    "constructor is stopped by Object.hasOwn"
  );
});

// ---------------------------------------------------------------------------
// ISS-7985 item 7: safeCount admits a fractional measurement. Tested through
// buildSyncFailureDiagnostic since safeCount is not exported.
//
// These two cases pin what safeCount DOES, not what it SHOULD do. Both values
// survive `Number.isFinite(value) ? Math.max(0, value) : 0` and are then carried
// onto the sync.batch span verbatim by buildSyncBatchAttributes
// (main/telemetry/app-otel-runtime.ts) — which does not validate. Both are
// nevertheless REJECTED by the published contract this attribute crosses:
// SyncPayloadBytes is `z.number().int().min(0)` at
// packages/telemetry-contract/sync.ts:172, so 1024.5 fails as invalid_type and
// MAX_SAFE_INTEGER + 1 fails as too_big. Narrowing safeCount to omit an invalid
// measurement is a functionality change and is out of ISS-7985's scope
// ("Tests only, no functionality change"); read these as a record of the
// contract gap, never as a blessing of it.
// ---------------------------------------------------------------------------

test("ISS-7985: a fractional payload size passes through safeCount unchanged", () => {
  const record = buildSyncFailureDiagnostic({
    ...baseInput(),
    payloadBytes: 1024.5,
  });
  assert.equal(
    record.payloadBytes,
    1024.5,
    "safeCount floors at 0 but does not Math.round, so a fractional byte total reaches the span — where the published contract rejects it as invalid_type"
  );
});

test("ISS-7985: a payload size past Number.MAX_SAFE_INTEGER passes through unchanged", () => {
  const pastSafe = Number.MAX_SAFE_INTEGER + 1;
  const record = buildSyncFailureDiagnostic({
    ...baseInput(),
    payloadBytes: pastSafe,
  });
  assert.equal(
    record.payloadBytes,
    pastSafe,
    "safeCount does not clamp at MAX_SAFE_INTEGER, so an imprecise-but-finite value reaches the span — where the published contract rejects it as too_big"
  );
});
