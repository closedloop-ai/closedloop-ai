/**
 * @file agent-session-sync-chunk-validation-classification.test.ts
 * @description ISS-5090 regression coverage: a `validation_failed` rejection of
 * one PART of a multi-part chunk sequence must not be charged against the
 * DETERMINISTIC per-row dead-letter budget, and must not park the session
 * terminally.
 *
 * Production (session `41f1a5d8…`, an ended Claude session): six three-part
 * attempts were rejected `validation_failed`, the session dead-lettered after
 * three consecutive rejections — the deterministic class, which gets an INFINITE
 * retry-after deadline and is revisited at most once per idle cycle — and then
 * the SAME persisted session was accepted in full hours later as a FOUR-part
 * sequence. Nothing about the row changed; only the partition did. So the
 * terminal classification was wrong: the rejection was attributable to the
 * envelope, not the row.
 *
 * These tests drive the REAL `AgentSessionSyncService` with the REAL payload
 * preparer over a genuinely oversized session (the chunk markers therefore come
 * from `chunkOversizedSession`, not a fixture), and pin:
 *   - a rejected chunk part dead-letters as the ENVELOPE class, on the SAME
 *     shared per-attempt budget (two counters would let a session whose envelope
 *     shape flips between attempts hold both below their ceilings forever);
 *   - its dead-letter is RECOVERABLE, so a server that starts accepting later in
 *     the same process still gets the session — no restart required;
 *   - that re-drive is itself BOUNDED: past `MAX_CHUNK_ENVELOPE_DEAD_LETTERS`
 *     cycles the class goes terminal, so a genuinely-invalid oversized row does
 *     not retry forever (sync/AGENTS.md invariant 5);
 *   - a WHOLE-session rejection is unchanged: deterministic budget, terminal
 *     dead-letter, revisited at most once per idle cycle;
 *   - the wire-level classifier reads `chunk.total` off the real chunker output,
 *     and a MULTI-id envelope still bisects before any envelope attribution.
 *
 * DETERMINISM (FEA-2399 / desktop AGENTS.md): every wait synchronizes on
 * observable service state and THROWS on exhaustion; the clock is pinned and
 * stepped explicitly, never slept on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  applyBoundedFailureFold,
  type BoundedFailureFoldConfig,
} from "../src/main/agent-sync/agent-session-sync-ack-fold.js";
import {
  DEAD_LETTER_RETRY_MAX_MS,
  MAX_CHUNK_ENVELOPE_DEAD_LETTERS,
  MAX_CONSECUTIVE_VALIDATION_FAILED,
  SESSION_PAYLOAD_CONTENT_BYTE_CAP,
  VALIDATION_FAILED_BACKOFF_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { prepareAgentSessionPayload } from "../src/main/agent-sync/agent-session-sync-payload.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  applyValidationFailure,
  CHUNK_VALIDATION_EXHAUSTED_REASON,
  CHUNK_VALIDATION_FAILED_REASON,
  classifyValidationFailure,
  isMultiPartSyncEnvelope,
  isValidationFailureReason,
  VALIDATION_FAILED_REASON,
  ValidationFailureClass,
  ValidationFailureDetail,
} from "../src/main/agent-sync/agent-session-sync-validation-failure.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import { pumpSyncDrainTurn } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "chunk-validation-target";
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);
const OVERSIZED_ID = "session-oversized";
const WHOLE_ID = "session-whole";
/**
 * Enough events that the real preparer splits the session across parts. Sized so
 * `prepareAgentSessionPayload` reproduces the production shape (a THREE-part
 * sequence) rather than a hand-built fixture, which is what makes the chunk
 * markers this test classifies on genuine production output.
 */
const OVERSIZED_EVENT_COUNT = 6000;
/** Bounded step budget for every drive loop; exhausting it is a real failure. */
const MAX_DRIVE_STEPS = 60;

function buildOversizedSession(): SyncedAgentSession {
  return makeSyncedSession(
    OVERSIZED_ID,
    "2026-06-08T13:00:00.000Z",
    Array.from({ length: OVERSIZED_EVENT_COUNT }, (_, i) => ({
      externalEventId: `evt-${i}`,
      eventType: "ToolUse",
      toolName: "Read",
      createdAt: "2026-06-08T12:30:00.000Z",
    }))
  );
}

/**
 * Pin `Date.now` to a virtual clock for `body`, restoring the real clock even if
 * `body` throws. Only the clock is mocked — ticks are driven explicitly — so a
 * retry/dead-letter window is stepped past deterministically instead of slept on.
 */
async function withPinnedClock(
  body: (clock: { advance: (ms: number) => void }) => Promise<void>
): Promise<void> {
  const realNow = Date.now;
  let virtualNow = realNow();
  Date.now = () => virtualNow;
  try {
    await body({
      advance: (ms) => {
        virtualNow += ms;
      },
    });
  } finally {
    Date.now = realNow;
  }
}

type DriveResult = { sends: number; acceptedIds: Set<string> };

/**
 * Run one session through the lane against a server that rejects the first
 * `rejectFirstSends` envelopes with `validation_failed` and accepts everything
 * after. Steps the clock past EVERY retry/dead-letter window on each iteration
 * (a step larger than the ladder's cap), so the loop measures whether the lane
 * ever re-drives the session again at all — not the specific schedule it uses.
 *
 * Returns once the session is accepted, or after the bounded step budget; the
 * caller asserts on the outcome so an unreachable acceptance surfaces as a
 * failed assertion rather than a silent pass.
 */
async function driveUntilAcceptedOrExhausted(
  session: SyncedAgentSession,
  rejectFirstSends: number
): Promise<DriveResult> {
  const source = new FakeSyncSource([session]);
  const acceptedIds = new Set<string>();
  let sends = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: (batch: AgentSessionSyncBatch) => {
      sends += 1;
      if (sends <= rejectFirstSends) {
        return Promise.resolve({
          accepted: false as const,
          reason: DesktopAgentSessionsAckReason.ValidationFailed,
        });
      }
      for (const sent of batch.sessions) {
        acceptedIds.add(sent.externalSessionId);
      }
      return Promise.resolve({ accepted: true as const });
    },
  });

  await withPinnedClock(async ({ advance }) => {
    service.start();
    for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
      await pumpSyncDrainTurn();
      if (acceptedIds.size > 0 && service.getSyncProgress().caughtUp) {
        return;
      }
      // One step past the LONGEST window the lane can impose (the dead-letter
      // ladder's cap dominates the per-attempt validation backoff), so any
      // deferred or set-aside session is eligible again on the next tick.
      advance(DEAD_LETTER_RETRY_MAX_MS + VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
    }
  });
  service.stop();
  return { sends, acceptedIds };
}

/**
 * Drive a session against a server that ALWAYS rejects, and return the number of
 * envelopes sent before the session first dead-lettered — i.e. the budget the
 * lane actually charged for that rejection class.
 */
async function countSendsBeforeFirstDeadLetter(
  session: SyncedAgentSession
): Promise<{ sends: number; outboxReason: string | undefined }> {
  const source = new FakeSyncSource([session]);
  let sends = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: () => {
      sends += 1;
      return Promise.resolve({
        accepted: false as const,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      });
    },
  });

  let sendsAtDeadLetter: number | null = null;
  await withPinnedClock(async ({ advance }) => {
    service.start();
    for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
      await pumpSyncDrainTurn();
      if (service.getSyncProgress().deadLetteredSessions > 0) {
        sendsAtDeadLetter = sends;
        return;
      }
      advance(VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
    }
  });
  const outboxReason = source.outbox.get(
    `${SOURCE_KEY}\0${OVERSIZED_ID}`
  )?.reason;
  service.stop();
  if (sendsAtDeadLetter === null) {
    // Never fall through onto a stale-state assertion (FEA-2399): an unbounded
    // retry budget is itself the regression, so surface it loudly here.
    throw new Error(
      `the session never dead-lettered after ${sends} rejected sends — the retry budget is unbounded`
    );
  }
  return { sends: sendsAtDeadLetter, outboxReason };
}

test("ISS-5090: the real preparer splits an oversized session into a multi-part envelope the classifier recognizes", () => {
  const prepared = prepareAgentSessionPayload(
    buildOversizedSession(),
    SESSION_PAYLOAD_CONTENT_BYTE_CAP
  );
  assert.equal(prepared.kind, "chunked");
  if (prepared.kind !== "chunked") {
    return;
  }
  assert.ok(
    prepared.chunkCount > 1,
    "the fixture must actually span multiple parts"
  );

  const partBatch = {
    sessions: [prepared.firstChunk],
  } as AgentSessionSyncBatch;
  assert.equal(
    isMultiPartSyncEnvelope(partBatch),
    true,
    "a part of a multi-part sequence is a multi-part envelope"
  );
  assert.equal(
    classifyValidationFailure(1, isMultiPartSyncEnvelope(partBatch)),
    ValidationFailureClass.ChunkEnvelope
  );

  // An unchunked session carries no marker; a session that chunked to exactly
  // one part is stamped `0 of 1`. Both are whole sessions.
  const wholeBatch = {
    sessions: [makeSyncedSession(WHOLE_ID, "2026-06-08T13:00:00.000Z")],
  } as AgentSessionSyncBatch;
  assert.equal(isMultiPartSyncEnvelope(wholeBatch), false);
  assert.equal(
    classifyValidationFailure(1, false),
    ValidationFailureClass.Row,
    "a whole-session rejection stays row-attributable"
  );
  const singlePartBatch = {
    sessions: [{ ...prepared.firstChunk, chunk: { index: 0, total: 1 } }],
  } as AgentSessionSyncBatch;
  assert.equal(isMultiPartSyncEnvelope(singlePartBatch), false);

  // A multi-id envelope names no session, so nothing may be charged yet.
  assert.equal(
    classifyValidationFailure(3, false),
    ValidationFailureClass.Bisect
  );
});

test("ISS-5090: a rejected chunk part dead-letters as the ENVELOPE class, not as a row defect", async () => {
  const chunked = await countSendsBeforeFirstDeadLetter(
    buildOversizedSession()
  );

  assert.equal(
    chunked.outboxReason,
    CHUNK_VALIDATION_FAILED_REASON,
    "the durable outbox records the envelope class, so an operator can tell it from a row defect"
  );
  // The per-attempt budget is deliberately SHARED with the row class: a
  // session's envelope shape can flip between attempts, and two counters would
  // let a flipping session hold both below their ceilings and never terminate.
  assert.equal(
    chunked.sends,
    MAX_CONSECUTIVE_VALIDATION_FAILED,
    "the classification changes how an exhausted budget is reported, not how large it is"
  );
});

test("ISS-5090: a chunk-envelope dead-letter is RECOVERABLE — a later-accepting server still gets the session in-process", async () => {
  // The production shape: the server rejected every early attempt and accepted
  // the same persisted session later. `rejectFirstSends` is set beyond what a
  // TERMINAL dead-letter can survive in one process (the deterministic class is
  // revisited at most once per idle cycle), so reaching acceptance proves the
  // lane keeps re-driving the session on the progressive recovery ladder.
  // One more than the pre-fix ceiling: a TERMINAL dead-letter allows at most
  // `MAX_CONSECUTIVE_VALIDATION_FAILED` sends, one idle-cycle promotion, and
  // that many again — so 2n+1 rejections are unreachable without the recovery
  // ladder, and comfortably inside the capped re-drive window with it.
  const rejectFirstSends = MAX_CONSECUTIVE_VALIDATION_FAILED * 2 + 1;
  const result = await driveUntilAcceptedOrExhausted(
    buildOversizedSession(),
    rejectFirstSends
  );

  assert.deepEqual(
    [...result.acceptedIds],
    [OVERSIZED_ID],
    `the session never reached the cloud after ${result.sends} attempts — a rejected chunk envelope parked a valid session`
  );
});

test("ISS-5090: a WHOLE-session validation_failed keeps its deterministic budget and terminal dead-letter", async () => {
  // Unchanged behaviour guard: the row-attributable class must NOT inherit the
  // envelope budget, and must stay terminal (revisited at most once per idle
  // cycle) so a genuinely poison row cannot hammer the server forever.
  const source = new FakeSyncSource([
    makeSyncedSession(WHOLE_ID, "2026-06-08T13:00:00.000Z"),
  ]);
  let sends = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: () => {
      sends += 1;
      return Promise.resolve({
        accepted: false as const,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      });
    },
  });

  let sendsAtDeadLetter: number | null = null;
  await withPinnedClock(async ({ advance }) => {
    service.start();
    for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
      await pumpSyncDrainTurn();
      if (
        sendsAtDeadLetter === null &&
        service.getSyncProgress().deadLetteredSessions > 0
      ) {
        sendsAtDeadLetter = sends;
      }
      advance(VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
    }
  });
  const outboxEntry = source.outbox.get(`${SOURCE_KEY}\0${WHOLE_ID}`);
  service.stop();

  assert.equal(
    sendsAtDeadLetter,
    MAX_CONSECUTIVE_VALIDATION_FAILED,
    "a whole-session rejection still dead-letters on the small deterministic budget"
  );
  assert.equal(
    outboxEntry?.reason,
    VALIDATION_FAILED_REASON,
    "the durable outbox still records the row-attributable class for a whole-session rejection"
  );
});

test("ISS-5090: the recoverable re-drive is BOUNDED — a permanently-rejected chunk sequence goes terminal", async () => {
  // The envelope class must not trade a terminal strand for an unbounded retry
  // (sync/AGENTS.md invariant 5). Every recovery resets the per-attempt budget,
  // so the number of RECOVERABLE dead-letters is capped separately; past the cap
  // the class becomes terminal and the lane stops re-driving the row.
  const source = new FakeSyncSource([buildOversizedSession()]);
  let sends = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: () => {
      sends += 1;
      return Promise.resolve({
        accepted: false as const,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      });
    },
  });

  let sendsAtTerminal: number | null = null;
  await withPinnedClock(async ({ advance }) => {
    service.start();
    for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
      await pumpSyncDrainTurn();
      if (
        sendsAtTerminal === null &&
        source.outbox.get(`${SOURCE_KEY}\0${OVERSIZED_ID}`)?.reason ===
          CHUNK_VALIDATION_EXHAUSTED_REASON
      ) {
        sendsAtTerminal = sends;
      }
      advance(DEAD_LETTER_RETRY_MAX_MS + VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
    }
  });
  const totalSends = sends;
  service.stop();

  assert.notEqual(
    sendsAtTerminal,
    null,
    `the envelope class never went terminal after ${totalSends} rejected sends — the re-drive is unbounded`
  );
  // Every step above skips a full 24h, so an unbounded ladder would re-drive on
  // each of the MAX_DRIVE_STEPS steps. Cap the total against the bounded budget
  // (recoverable cycles + the terminal cycle + one idle-cycle promotion) so a
  // regression to unbounded retry fails loudly instead of merely being slower.
  const boundedCeiling =
    MAX_CONSECUTIVE_VALIDATION_FAILED * (MAX_CHUNK_ENVELOPE_DEAD_LETTERS + 2);
  assert.ok(
    totalSends <= boundedCeiling,
    `expected at most ${boundedCeiling} rejected sends once the class goes terminal, saw ${totalSends}`
  );
});

test("ISS-5090: a MULTI-id envelope still bisects even when it carries a chunk marker", () => {
  // `isMultiPartSyncEnvelope` is a `.some()` over the batch, so a mixed batch
  // reads as multi-part. Bisection precedence is what keeps that safe — the ack
  // names no session, so nothing may be charged until the batch is re-sent one
  // id at a time. Pin the precedence rather than relying on batch composition.
  const prepared = prepareAgentSessionPayload(
    buildOversizedSession(),
    SESSION_PAYLOAD_CONTENT_BYTE_CAP
  );
  assert.equal(prepared.kind, "chunked");
  if (prepared.kind !== "chunked") {
    return;
  }
  const mixedBatch = {
    sessions: [
      prepared.firstChunk,
      makeSyncedSession(WHOLE_ID, "2026-06-08T13:00:00.000Z"),
    ],
  } as AgentSessionSyncBatch;

  assert.equal(isMultiPartSyncEnvelope(mixedBatch), true);
  assert.equal(
    classifyValidationFailure(2, isMultiPartSyncEnvelope(mixedBatch)),
    ValidationFailureClass.Bisect,
    "a multi-id rejection must bisect before any envelope attribution applies"
  );
});

test("ISS-5090: a session whose envelope shape FLIPS between attempts still reaches a dead-letter", () => {
  // The failure mode a per-class counter would introduce: the activity-chunking
  // capability is renegotiated on reconnect and gzip changes the effective cap,
  // so the same session can be prepared whole on one attempt and multi-part on
  // the next. With two counters neither would ever reach its ceiling and the
  // session would retry every 30s forever, never dead-lettering and never
  // letting the watermark persist. Drive the real classifier over the real
  // bounded fold with an alternating envelope shape and require a dead-letter.
  const counter = new Map<string, number>();
  const deadLettered: string[] = [];
  const deps = {
    counter,
    recoverableDeadLetterCountFor: () => 0,
    markForBisection: () => {
      throw new Error("single-id rejections must never bisect");
    },
    clearBisectionFlag: () => undefined,
    applyBoundedFold: (config: BoundedFailureFoldConfig) =>
      applyBoundedFailureFold(config, {
        nextRetryAfterMs: new Map<string, number>(),
        clearFailureStateForId: (id) => counter.delete(id),
        markDeadLettered: (id) => deadLettered.push(id),
        dequeue: () => undefined,
        recordOutboxRetry: () => undefined,
        queueSizes: () => ({ incremental: 0, backfill: 0, deadLettered: 0 }),
        logWarn: () => undefined,
        logInfo: () => undefined,
        formatBytes: (bytes) => `${bytes}B`,
      }),
    logInfo: () => undefined,
    formatBytes: (bytes: number) => `${bytes}B`,
  };

  for (
    let attempt = 0;
    attempt < MAX_CONSECUTIVE_VALIDATION_FAILED;
    attempt++
  ) {
    applyValidationFailure(
      {
        syncMode: AgentSessionSyncMode.Backfill,
        ids: [OVERSIZED_ID],
        payloadBytes: 1024,
        // Alternate whole / multi-part on every attempt.
        multiPartEnvelope: attempt % 2 === 0,
      },
      deps
    );
  }

  assert.deepEqual(
    deadLettered,
    [OVERSIZED_ID],
    "an alternating envelope shape must still exhaust ONE shared budget and dead-letter"
  );
});

/** A `details.reason` value no build of this lane discriminates on. */
const UNKNOWN_SERVER_DETAIL = "a_reason_this_build_has_never_heard_of";

type DetailDriveResult = {
  sends: number;
  peakDeadLettered: number;
  accepted: boolean;
  outboxReason: string | undefined;
};

/**
 * Drive ONE whole session through the REAL `AgentSessionSyncService` against a
 * server that rejects the first `rejectFirstSends` envelopes as
 * `validation_failed` carrying `details.reason = detail`, then accepts.
 *
 * Samples the dead-letter count on every step while the server is still
 * rejecting, so a budget that WAS charged surfaces as a non-zero peak rather
 * than as a merely-slower run. Omits `detail` entirely when it is `undefined`,
 * matching the older-API wire shape the client preserves.
 */
async function driveWithRejectionDetail(
  detail: string | undefined,
  rejectFirstSends: number
): Promise<DetailDriveResult> {
  const source = new FakeSyncSource([
    makeSyncedSession(WHOLE_ID, "2026-06-08T13:00:00.000Z"),
  ]);
  let sends = 0;
  let accepted = false;
  let peakDeadLettered = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: () => {
      sends += 1;
      if (sends <= rejectFirstSends) {
        return Promise.resolve({
          accepted: false as const,
          reason: DesktopAgentSessionsAckReason.ValidationFailed,
          ...(detail ? { detail } : {}),
        });
      }
      accepted = true;
      return Promise.resolve({ accepted: true as const });
    },
  });

  await withPinnedClock(async ({ advance }) => {
    service.start();
    for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
      await pumpSyncDrainTurn();
      const progress = service.getSyncProgress();
      if (sends <= rejectFirstSends) {
        peakDeadLettered = Math.max(
          peakDeadLettered,
          progress.deadLetteredSessions
        );
      }
      if (accepted && progress.caughtUp) {
        return;
      }
      advance(DEAD_LETTER_RETRY_MAX_MS + VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
    }
  });
  const outboxReason = source.outbox.get(`${SOURCE_KEY}\0${WHOLE_ID}`)?.reason;
  service.stop();
  return { sends, peakDeadLettered, accepted, outboxReason };
}

test("ISS-5090: a schema_version_invalid rejection is lane-wide and budget-neutral through the real service", async () => {
  // wongk: the discriminator reached this classifier through `details.reason`
  // but was ignored, so version skew was classified off the batch SHAPE and
  // charged to whichever rows were in flight until they dead-lettered. A schema
  // rejection is a fact about THIS DESKTOP BUILD's envelope — no row can be at
  // fault and no amount of retrying by this build can fix it — so it must spend
  // nothing. Reject well past the per-row budget, then upgrade the server.
  const rejectFirstSends = MAX_CONSECUTIVE_VALIDATION_FAILED * 3;
  const result = await driveWithRejectionDetail(
    ValidationFailureDetail.SchemaVersionInvalid,
    rejectFirstSends
  );

  // Guard the guard: budget-neutrality is only exercised if the drive actually
  // pushed PAST the row budget. Without this, a lane that stopped re-sending
  // after one rejection would satisfy every assertion below.
  assert.equal(
    result.sends,
    rejectFirstSends + 1,
    `expected ${rejectFirstSends} rejected sends then one accepted, saw ${result.sends} — the skew defer stopped re-driving the batch`
  );
  assert.equal(
    result.peakDeadLettered,
    0,
    `a schema-skew rejection charged a session's budget and dead-lettered it after ${result.sends} sends — skew must be budget-neutral`
  );
  assert.equal(
    isValidationFailureReason(result.outboxReason ?? null),
    false,
    "a budget-neutral skew defer must write no durable validation-failure last_error, or resume would replay it as a consecutive rejection"
  );
  assert.equal(
    result.accepted,
    true,
    `the session never reached the cloud after ${result.sends} sends — the skew defer parked a valid session instead of holding it queued`
  );
});

test("ISS-5090: an UNKNOWN details.reason degrades to the existing generic classification", async () => {
  // Cross-repo compatibility: a newer API may invent reason values this build
  // has never seen, and an older one sends none at all. Neither may steer the
  // lane — both must behave exactly like today's shape-derived path, which for a
  // whole session is the deterministic budget and a terminal dead-letter.
  const unknown = await driveWithRejectionDetail(
    UNKNOWN_SERVER_DETAIL,
    Number.POSITIVE_INFINITY
  );
  const omitted = await driveWithRejectionDetail(
    undefined,
    Number.POSITIVE_INFINITY
  );

  assert.ok(
    unknown.peakDeadLettered > 0,
    "an unknown reason must not be treated as skew — it still spends the row budget and dead-letters"
  );
  assert.equal(
    unknown.outboxReason,
    VALIDATION_FAILED_REASON,
    "an unknown reason records the row-attributable class, exactly as a detail-free rejection does"
  );
  assert.equal(
    omitted.outboxReason,
    VALIDATION_FAILED_REASON,
    "an older API that sends no details.reason is unchanged by the discriminator"
  );
});

test("ISS-5090: the schema-skew discriminator is read BEFORE the envelope/row split", () => {
  // Precedence, pinned at the classifier: the batch shape must not be able to
  // out-rank the discriminator in either direction. A multi-id envelope would
  // otherwise bisect (re-sending each id alone against a server that rejects
  // every schema version), and a chunk marker would otherwise attribute the
  // skew to the envelope and burn the bounded re-drive budget.
  for (const [idCount, multiPart] of [
    [1, false],
    [1, true],
    [3, false],
    [3, true],
  ] as const) {
    assert.equal(
      classifyValidationFailure(
        idCount,
        multiPart,
        ValidationFailureDetail.SchemaVersionInvalid
      ),
      ValidationFailureClass.SchemaSkew,
      `schema skew must outrank the batch shape (ids=${idCount}, multiPart=${multiPart})`
    );
  }

  // ...and every other value leaves the shape-derived classification untouched.
  assert.equal(
    classifyValidationFailure(1, true, UNKNOWN_SERVER_DETAIL),
    ValidationFailureClass.ChunkEnvelope
  );
  assert.equal(
    classifyValidationFailure(1, false, UNKNOWN_SERVER_DETAIL),
    ValidationFailureClass.Row
  );
  assert.equal(
    classifyValidationFailure(3, false, UNKNOWN_SERVER_DETAIL),
    ValidationFailureClass.Bisect
  );
  assert.equal(
    classifyValidationFailure(1, false, undefined),
    ValidationFailureClass.Row,
    "an omitted details.reason is the older-API shape and must not change classification"
  );
});

/**
 * A `details.reason` carrying everything a console sink INTERPRETS rather than
 * prints: a newline (forges a second log line), a carriage return, an ANSI SGR
 * introducer (drives the terminal), NUL, and DEL.
 */
const MALFORMED_SERVER_DETAIL =
  "reason one\nfake: forged second log line\r\u001B[31mred\u0000\u007F";

/** Longer than the logged-detail cap on both sides of the strip. */
const CONTROL_PREFIX_LENGTH = 200;

/** The printable tail the cap-ordering test expects to survive stripping. */
const SERVER_DETAIL_TAIL_PATTERN = /\(server detail: (x+)\)/;

/**
 * Codepoint scan for C0 (U+0000–U+001F) and DEL (U+007F). Deliberately not a
 * regex: the assertion is about what actually reached the sink, and a scan
 * reports WHICH character got through rather than only that one did.
 */
function findControlCharCode(value: string): number | undefined {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return code;
    }
  }
  return undefined;
}

/**
 * Drive ONE single-id whole-session rejection through the REAL classifier with
 * the given untrusted server `detail`, capturing everything it writes to the
 * gateway log sink. `applyBoundedFold` is inert so the only messages collected
 * are the classifier's own interpolation — the boundary under test.
 */
function captureRejectionLogs(detail: string | undefined): string[] {
  const messages: string[] = [];
  applyValidationFailure(
    {
      syncMode: AgentSessionSyncMode.Backfill,
      ids: [WHOLE_ID],
      payloadBytes: 1024,
      multiPartEnvelope: false,
      ...(detail === undefined ? {} : { detail }),
    },
    {
      counter: new Map<string, number>(),
      recoverableDeadLetterCountFor: () => 0,
      markForBisection: () => {
        throw new Error("a single-id rejection must never bisect");
      },
      clearBisectionFlag: () => undefined,
      applyBoundedFold: () => undefined,
      logInfo: (message: string) => messages.push(message),
      formatBytes: (bytes: number) => `${bytes}B`,
    }
  );
  return messages;
}

test("ISS-5090: a malformed details.reason cannot inject control characters into the log sink", () => {
  // wongk: a length cap is not sanitization. `details.reason` is an untrusted
  // string from a version-skewed peer, a proxy error page, or anyone who can
  // answer the sync POST, and it is interpolated straight into the gateway
  // console sink. Drive the real classifier and inspect what reached the sink.
  const messages = captureRejectionLogs(MALFORMED_SERVER_DETAIL);

  assert.equal(
    messages.length,
    1,
    "a detail-carrying rejection must log exactly once — that line is the sink under test"
  );
  const control = findControlCharCode(messages[0]);
  assert.equal(
    control,
    undefined,
    `the log line reached the console sink carrying U+${(control ?? 0)
      .toString(16)
      .padStart(4, "0")
      .toUpperCase()} — C0/DEL must be stripped before interpolation`
  );
  assert.ok(
    messages[0].includes(
      "(server detail: reason onefake: forged second log line[31mred)"
    ),
    `the printable residue must survive stripping rather than the whole detail being dropped, got: ${messages[0]}`
  );
});

test("ISS-5090: sanitizing the server detail adds no marker and emits no hollow suffix", () => {
  // Sanitizer discipline: a marker is emitted only when something was actually
  // matched, and this helper strips terminal-control noise rather than redacting
  // meaning — so a clean detail survives VERBATIM with nothing added, and a
  // detail that is ENTIRELY control characters reads exactly like an absent one
  // instead of printing an empty `(server detail: )`.
  const clean = captureRejectionLogs(UNKNOWN_SERVER_DETAIL);
  assert.equal(clean.length, 1, "a clean detail still logs its suffix");
  assert.ok(
    clean[0].includes(`(server detail: ${UNKNOWN_SERVER_DETAIL})`),
    `a detail with nothing to strip must pass through unchanged and unmarked, got: ${clean[0]}`
  );

  assert.deepEqual(
    captureRejectionLogs("\n\r\u001B\u0000\u007F"),
    captureRejectionLogs(undefined),
    "a fully-stripped detail must read identically to an absent one — never a hollow `(server detail: )`"
  );
});

test("ISS-5090: the logged-detail cap measures the SANITIZED string, not the raw one", () => {
  // Order of operations, pinned: stripping must run BEFORE the length cap, or
  // the cap budgets room for bytes that are about to be removed. A detail whose
  // leading 200 characters are all control characters discriminates the two —
  // sanitize first and the printable tail survives (capped); truncate first and
  // the cap consumes only doomed bytes and the whole suffix disappears.
  const messages = captureRejectionLogs(
    "\n".repeat(CONTROL_PREFIX_LENGTH) + "x".repeat(CONTROL_PREFIX_LENGTH)
  );

  assert.equal(messages.length, 1, "the surviving tail must still be logged");
  const match = SERVER_DETAIL_TAIL_PATTERN.exec(messages[0]);
  assert.ok(
    match,
    `the printable tail was truncated away — the cap ran before the strip, got: ${messages[0]}`
  );
  assert.ok(
    match[1].length < CONTROL_PREFIX_LENGTH,
    `the cap did not apply to the sanitized detail (${match[1].length} characters echoed)`
  );
});
