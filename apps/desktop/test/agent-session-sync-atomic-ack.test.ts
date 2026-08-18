/**
 * @file agent-session-sync-atomic-ack.test.ts
 * @description Goal stage 2 — the atomic row-level clear-on-ack contract,
 * split out of the (grandfathered, shrink-only) main sync-service suite.
 *
 * The two decisive fixtures:
 *  - a kill mid-batch after PARTIAL acks re-uploads only the un-acked rows
 *    (the durable clear is keyed on the server's `acceptedSessionIds` echo);
 *  - a FAILED durable clear aborts ack processing with budgets intact, so the
 *    ledger can never say `pending` while the in-memory lane says acked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import {
  ACK_OMITTED_BACKOFF_MS,
  DEAD_LETTER_RETRY_MAX_MS,
  MAX_ACK_OMITTED_DEAD_LETTERS,
  MAX_CONSECUTIVE_ACK_OMITTED,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type { AgentSessionSyncTransportPayload } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { DesktopSyncBatchEventInput } from "../src/main/telemetry/app-otel-runtime.js";
import { DesktopSyncBatchOutcome } from "../src/main/telemetry/app-otel-runtime.js";
import {
  flushAgentSessionSync,
  makeOversizedSession,
  makeService,
  makeServiceWithIdentity,
  runWithMockedNow,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

test("FEA-3473 AC-1: a kill mid-batch after PARTIAL acks re-uploads only the un-acked rows on restart", async () => {
  // Goal stage 2 (atomic row-level ack): with byte-budgeted batching the whole
  // six-session corpus ships as ONE envelope, so the durability boundary moved
  // INSIDE the batch. The server's `acceptedSessionIds` echo confirms a prefix
  // (s6/s5/s4) and omits the rest; the atomic clear must delete EXACTLY the
  // echoed rows' outbox entries before any in-memory advance, so a kill right
  // after ack processing leaves s3/s2/s1 — and only them — durably `pending`.
  // A restart (new service, same durable source) re-uploads ONLY those:
  // row-level durability, even inside a single batch.
  const TARGET = "target-ac1";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("s6", "2026-06-08T12:06:00.000Z"),
    makeSyncedSession("s5", "2026-06-08T12:05:00.000Z"),
    makeSyncedSession("s4", "2026-06-08T12:04:00.000Z"),
    makeSyncedSession("s3", "2026-06-08T12:03:00.000Z"),
    makeSyncedSession("s2", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("s1", "2026-06-08T12:01:00.000Z"),
  ]);

  await runWithMockedNow(async ({ advance }) => {
    const firstRunSent: string[][] = [];
    const first = makeServiceWithIdentity(
      source,
      (batch) => {
        firstRunSent.push(batch.sessions.map((s) => s.externalSessionId));
        if (firstRunSent.length > 1) {
          // The kill: no follow-up send ever gets a server answer.
          return Promise.reject(new Error("killed after the partial ack"));
        }
        // The server persisted only the first three rows of the batch and says
        // exactly which ones.
        return Promise.resolve({
          accepted: true as const,
          acceptedSessionIds: ["s6", "s5", "s4"],
        });
      },
      TARGET
    );
    first.start();
    for (let i = 0; i < 3; i++) {
      await flushAgentSessionSync();
    }
    first.stop();

    assert.deepEqual(
      firstRunSent[0],
      ["s6", "s5", "s4", "s3", "s2", "s1"],
      "the whole corpus ships as one byte-budgeted batch"
    );
    const pendingAfterKill = source.pendingOutboxIds(key).sort();
    assert.deepEqual(
      pendingAfterKill,
      ["s1", "s2", "s3"],
      "echoed ids are cleared atomically; ONLY the un-echoed rows survive as pending"
    );

    // Restart after the ack-omitted backoff window (the omitted rows recorded a
    // durable deferred retry; a restart inside the window correctly defers them).
    advance(ACK_OMITTED_BACKOFF_MS + 1);
    const restartSent: string[][] = [];
    source.loadSyncedSessionIds.length = 0;
    const restarted = makeServiceWithIdentity(
      source,
      (batch) => {
        restartSent.push(batch.sessions.map((s) => s.externalSessionId));
        return Promise.resolve({ accepted: true as const });
      },
      TARGET
    );
    restarted.start();
    for (let i = 0; i < 8; i++) {
      await flushAgentSessionSync();
      restarted.refresh();
    }
    restarted.stop();

    const allRestartUploaded = new Set(restartSent.flat());
    // Every un-acked id reached the cloud (durability — the core AC-1 guarantee).
    for (const id of ["s1", "s2", "s3"]) {
      assert.ok(
        allRestartUploaded.has(id),
        `restart must re-upload un-acked session ${id}`
      );
    }
    // And no acked id was re-uploaded (the row-level property: the clear was
    // keyed on the server echo, so the acked prefix never re-sends).
    for (const id of ["s4", "s5", "s6"]) {
      assert.ok(
        !allRestartUploaded.has(id),
        `restart must NOT re-upload already-acked session ${id}`
      );
    }
  });
});

test("goal stage 2: a failed durable ack-clear aborts ack processing — the row stays queued (budgets intact), re-sends, and clears on the re-ack", async () => {
  // The observed disease: "failed to clear N acked outbox row(s): db-host
  // exited" — the ack was processed in memory while the durable clear silently
  // failed, so acked work re-sent on every launch. Now the clear IS the ack
  // processing: when it cannot commit, NOTHING advances — the row stays queued
  // in memory AND `pending` in the outbox, no failure budget is burned (the
  // clear failure is lane-wide local-DB trouble, not a payload verdict), and
  // the next pass re-sends (the server dedupes) and re-attempts the clear.
  const TARGET = "target-clear-fail";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  class ClearFailingSyncSource extends FakeSyncSource {
    failClears = true;
    clearAttempts = 0;
    override clearOutboxEntries(sourceKey: string, ids: string[]): void {
      this.clearAttempts += 1;
      if (this.failClears) {
        throw new Error("db-host exited");
      }
      super.clearOutboxEntries(sourceKey, ids);
    }
  }
  const source = new ClearFailingSyncSource([
    makeSyncedSession("s1", "2026-06-08T12:01:00.000Z"),
  ]);
  const sent: string[][] = [];
  const telemetry: { sync: DesktopSyncBatchEventInput[] } = { sync: [] };
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      const ids = batch.sessions.map((s) => s.externalSessionId);
      sent.push(ids);
      return Promise.resolve({
        accepted: true as const,
        acceptedSessionIds: ids,
      });
    },
    TARGET,
    telemetry
  );

  service.start();
  await service.whenSessionSyncSettled();
  assert.deepEqual(sent, [["s1"]], "the row was sent and acked once");
  assert.equal(source.clearAttempts, 1, "the ack attempted the durable clear");
  assert.deepEqual(
    source.pendingOutboxIds(key),
    ["s1"],
    "the failed clear leaves the row durably pending (never in-memory-acked past the ledger)"
  );
  assert.equal(
    service.getSyncProgress().pendingBackfillSessions,
    1,
    "ack processing aborted — the row is still queued"
  );
  // The window in which acked cloud work gets re-sent must be MEASURED, not
  // silent — that is the whole point of the reason existing.
  assert.deepEqual(
    telemetry.sync
      .filter((event) => event.reason === SyncReason.AckClearFailed)
      .map((event) => event.outcome),
    [DesktopSyncBatchOutcome.Failure],
    "the failed durable clear emits exactly one ack_clear_failed Failure event"
  );
  assert.ok(
    !telemetry.sync.some(
      (event) => event.outcome === DesktopSyncBatchOutcome.Success
    ),
    "a batch whose clear never committed must NOT report a Success outcome"
  );

  // The DB comes back: the very next tick re-sends with budgets intact (no
  // backoff was armed — the failure was lane-wide, not row-attributable), the
  // re-ack's clear commits, and the lane advances.
  source.failClears = false;
  service.refresh();
  await service.whenSessionSyncSettled();
  service.stop();

  assert.deepEqual(sent, [["s1"], ["s1"]], "the row re-sent exactly once");
  assert.deepEqual(
    source.pendingOutboxIds(key),
    [],
    "the re-ack's clear committed"
  );
  const progress = service.getSyncProgress();
  assert.equal(
    progress.deadLetteredSessions,
    0,
    "the clear failure burned no dead-letter budget"
  );
  assert.equal(progress.pendingBackfillSessions, 0, "the queue drained");
});

test("goal stage 2: a stop() racing the durable clear leaves the committed delete alone and reports NO success", async () => {
  // The clear is awaited, so a lifecycle change can land between the ack and
  // the in-memory advance. The delete (if it committed) is still correct — those
  // rows WERE acked — but the in-memory state now belongs to a dead lifecycle,
  // so ack processing must abandon it to the reset/re-hydration machinery rather
  // than advance queues and claim a sync that this lifecycle never finished.
  const TARGET = "target-stop-race";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  class StopDuringClearSource extends FakeSyncSource {
    stopOnClear: (() => void) | null = null;
    override clearOutboxEntries(sourceKey: string, ids: string[]): void {
      // Fires INSIDE the awaited clear, i.e. exactly in the race window.
      this.stopOnClear?.();
      super.clearOutboxEntries(sourceKey, ids);
    }
  }
  const source = new StopDuringClearSource([
    makeSyncedSession("s1", "2026-06-08T12:01:00.000Z"),
  ]);
  const telemetry: { sync: DesktopSyncBatchEventInput[] } = { sync: [] };
  const service = makeServiceWithIdentity(
    source,
    (batch) =>
      Promise.resolve({
        accepted: true as const,
        acceptedSessionIds: batch.sessions.map((s) => s.externalSessionId),
      }),
    TARGET,
    telemetry
  );
  source.stopOnClear = () => service.stop();

  service.start();
  await service.whenSessionSyncSettled();

  assert.deepEqual(
    source.pendingOutboxIds(key),
    [],
    "the durable delete still committed — those rows were genuinely acked"
  );
  assert.ok(
    !telemetry.sync.some(
      (event) => event.outcome === DesktopSyncBatchOutcome.Success
    ),
    "the superseded lifecycle must not report a Success batch outcome"
  );
});

test("goal stage 2: a row the echo keeps omitting burns a BOUNDED ack_omitted budget, then dead-letters recoverably", async () => {
  // Dormant only against an all-or-nothing server. The real server skips a
  // foreign chunk without throwing, so a row CAN be omitted from an accepted
  // batch repeatedly — it must not retry forever, and it must not be lost.
  const TARGET = "target-ack-omitted";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("s2", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("s1", "2026-06-08T12:01:00.000Z"),
  ]);
  const telemetry: { sync: DesktopSyncBatchEventInput[] } = { sync: [] };
  const sentBatches: string[][] = [];

  await runWithMockedNow(async ({ advance }) => {
    const service = makeServiceWithIdentity(
      source,
      (batch) => {
        sentBatches.push(batch.sessions.map((s) => s.externalSessionId));
        return Promise.resolve({
          accepted: true as const,
          // The server persists everything EXCEPT s1, every single time.
          acceptedSessionIds: batch.sessions
            .map((s) => s.externalSessionId)
            .filter((id) => id !== "s1"),
        });
      },
      TARGET,
      telemetry
    );

    service.start();
    for (
      let attempt = 0;
      attempt < MAX_CONSECUTIVE_ACK_OMITTED + 2;
      attempt++
    ) {
      await flushAgentSessionSync();
      advance(ACK_OMITTED_BACKOFF_MS + 1);
      service.refresh();
    }
    // Read BEFORE stop() — stop() clears source-derived state, dead-letters
    // included, so a post-stop read would report 0 whatever happened.
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      1,
      "the persistently omitted row dead-letters instead of retrying forever"
    );
    // Bounded, not merely eventual: the row is re-sent exactly
    // MAX_CONSECUTIVE_ACK_OMITTED times before the budget is spent.
    assert.deepEqual(
      sentBatches,
      [["s2", "s1"], ["s1"], ["s1"], ["s1"], ["s1"]],
      "the omitted row retries on a bounded budget, then stops"
    );
    service.stop();
  });

  const omitted = telemetry.sync.filter(
    (event) => event.reason === SyncReason.AckOmitted
  );
  assert.ok(
    omitted.length > 0,
    `the omission is reported under its own reason; saw ${JSON.stringify(
      telemetry.sync.map((e) => e.reason)
    )}`
  );
  assert.ok(
    omitted.some(
      (event) => event.outcome === DesktopSyncBatchOutcome.DeadLetter
    ),
    "budget exhaustion escalates the ack_omitted events to DeadLetter"
  );
  assert.deepEqual(
    source.pendingOutboxIds(key),
    [],
    "the acked neighbour cleared; the dead-lettered row is no longer pending"
  );
});

test("goal stage 2: a permanently omitted row's re-drive is BOUNDED by MAX_ACK_OMITTED_DEAD_LETTERS", () => {
  // The second-order bound (ISS-5090's, applied to `ack_omitted`). Recovery
  // clears `ackOmittedCountById`, so a row the server never confirms would
  // otherwise start a fresh MAX_CONSECUTIVE_ACK_OMITTED cycle every retry
  // window for the life of the process — unbounded retry, and unbounded
  // dead-letter telemetry with it (sync/AGENTS.md invariant 5). The surviving
  // `ackOmittedCycleById` count makes the class terminal instead.
  //
  // Shaped like the sibling ISS-5090 fixture: every step skips past the
  // progressive ladder's 24h cap, so an unbounded re-drive would send on nearly
  // every one of the MAX_DRIVE_STEPS steps. Asserting a CEILING (not an exact
  // count) keeps the once-per-idle-cycle dead-letter promotion — which revisits
  // terminal rows too, and always has — from making this brittle, while still
  // failing loudly on a regression to unbounded retry.
  const MAX_DRIVE_STEPS = 40;
  const TARGET = "target-ack-omitted-terminal";
  const source = new FakeSyncSource([
    makeSyncedSession("s1", "2026-06-08T12:01:00.000Z"),
  ]);
  let s1Sends = 0;

  return runWithMockedNow(async ({ advance }) => {
    const service = makeServiceWithIdentity(
      source,
      (batch) => {
        for (const session of batch.sessions) {
          if (session.externalSessionId === "s1") {
            s1Sends++;
          }
        }
        // The batch is ACCEPTED and the server persists nothing — a foreign
        // chunk whose assembly mismatch never resolves.
        return Promise.resolve({
          accepted: true as const,
          acceptedSessionIds: [],
        });
      },
      TARGET
    );

    service.start();
    for (let step = 0; step < MAX_DRIVE_STEPS; step++) {
      await flushAgentSessionSync();
      advance(DEAD_LETTER_RETRY_MAX_MS + ACK_OMITTED_BACKOFF_MS + 1);
      service.refresh();
    }
    service.stop();

    const boundedCeiling =
      MAX_CONSECUTIVE_ACK_OMITTED * (MAX_ACK_OMITTED_DEAD_LETTERS + 2);
    assert.ok(
      s1Sends > MAX_CONSECUTIVE_ACK_OMITTED,
      `the row IS re-driven while cycles remain, saw ${s1Sends} send(s)`
    );
    assert.ok(
      s1Sends <= boundedCeiling,
      `expected at most ${boundedCeiling} sends once the class goes terminal over ${MAX_DRIVE_STEPS} 24h+ steps, saw ${s1Sends}`
    );
  });
});

test("PR #4862 (codex-connector P1): EVERY chunk of a drained tail requests the acceptedSessionIds echo", async () => {
  // The stage-2 echo is REQUEST-GATED server-side: `desktop-agent-sessions-handler.ts`
  // returns `acceptedSessionIds` only when the batch set `wantsAcceptedSessionIds`.
  // The fresh-drain `buildBatch` set it, but `resolvePendingChunkTransition` built
  // the TAIL batches without it — so every chunk after the first got a legacy
  // `{ synced: true }`, which the client reads as the whole-batch ack and uses to
  // durably clear the outbox row. That is the accept-without-persist hole stage 2
  // exists to close, left open on the one path where the server's `persisted:false`
  // skip is actually reachable (`isForeignChunk` is a chunked-payload condition).
  //
  // COUNTERFACTUAL: with the flag removed from `resolvePendingChunkTransition`,
  // every tail chunk (index >= 1) reports `wantsAcceptedSessionIds === undefined`
  // and this assertion fails.
  const source = new FakeSyncSource([makeOversizedSession("oversized")]);
  const sent: AgentSessionSyncTransportPayload[] = [];
  const service = makeService(source, (batch) => {
    sent.push(batch);
    return Promise.resolve({
      accepted: true as const,
      acceptedSessionIds: batch.sessions.map((s) => s.externalSessionId),
    });
  });

  service.start();
  for (let tick = 0; tick < 6; tick++) {
    await flushAgentSessionSync();
    service.refresh();
  }
  service.stop();

  const tailChunks = sent.filter(
    (batch) => (batch.sessions[0]?.chunk?.index ?? 0) > 0
  );
  assert.ok(
    tailChunks.length > 0,
    "the oversized session must have produced at least one TAIL chunk"
  );
  assert.deepEqual(
    tailChunks.map((batch) => batch.wantsAcceptedSessionIds),
    tailChunks.map(() => true),
    "every drained tail chunk opts in to the row-level echo, exactly as the fresh-drain batch does"
  );
});

test("PR #4862 (codex-connector P1): a NON-final chunk accepted but omitted from the echo discards the tail instead of draining over the hole", async () => {
  // A non-final chunk the server ACCEPTED but did not PERSIST (the `isForeignChunk`
  // skip) leaves a hole the rest of the tail can never fill: the server advances
  // `pendingChunkReceived` only for a contiguous in-sequence chunk, so the final
  // chunk arrives against a short count and never commits the revision. Worse, a
  // later in-sequence chunk landing over that gap is NOT foreign, so it reports
  // `persisted: true` and the echo acks it — clearing the outbox row for a session
  // the server never committed. The drain must abandon the tail on the omission so
  // the still-queued session re-prepares from chunk 0 and re-stages the sequence.
  //
  // COUNTERFACTUAL: without the fix (`splitAckedIds` short-circuiting on
  // `hasMoreChunks`, so a non-final omission is invisible) the drain continues and
  // the NEXT send after the rejected chunk is a mid-tail resume at index 2 rather
  // than a fresh chunk 0 — the assertion below fails with `2 !== 0`.
  // Big enough to split into 3+ chunks so index 1 is genuinely INTERIOR — the
  // only shape that exercises this path. `makeOversizedSession` splits into two,
  // where index 1 is the FINAL chunk and the (already covered) final-chunk
  // omission fold handles it instead. Same construction as the ISS-4578 tail
  // regression in the sibling suite, for the same reason.
  const bigEvents = Array.from({ length: 12_000 }, (_, index) => ({
    externalEventId: `oversized-event-${index}`,
    eventType: "ToolUse",
    toolName: "Read",
    createdAt: "2026-06-08T12:00:00.000Z",
  }));
  const source = new FakeSyncSource([
    makeSyncedSession("oversized", "2026-06-08T12:00:00.000Z", bigEvents),
  ]);
  // Each send attempt's chunk index, so the recovery step can be pinned exactly.
  const attempts: number[] = [];
  let rejectedOnce = false;

  await runWithMockedNow(async ({ advance }) => {
    const service = makeService(source, (batch) => {
      const chunkIndex = batch.sessions[0]?.chunk?.index ?? 0;
      attempts.push(chunkIndex);
      // Reject exactly once, on the first INTERIOR (non-final) chunk: accepted at
      // the batch level, but the row is absent from the echo.
      if (!rejectedOnce && chunkIndex === 1) {
        rejectedOnce = true;
        return Promise.resolve({
          accepted: true as const,
          acceptedSessionIds: [],
        });
      }
      return Promise.resolve({
        accepted: true as const,
        acceptedSessionIds: batch.sessions.map((s) => s.externalSessionId),
      });
    });

    service.start();
    for (let tick = 0; tick < 10; tick++) {
      await flushAgentSessionSync();
      // The omission burns the bounded `ack_omitted` budget, which defers the row
      // with backoff — step past it so the re-prepare is observable.
      advance(ACK_OMITTED_BACKOFF_MS + 1);
      service.refresh();
    }
    service.stop();
  });

  assert.ok(rejectedOnce, "the interior-chunk omission must have fired");
  const rejectedAt = attempts.indexOf(1);
  const nextAfterRejection = attempts[rejectedAt + 1];
  assert.ok(
    nextAfterRejection !== undefined,
    "the session must be retried after the omitted interior chunk"
  );
  assert.equal(
    nextAfterRejection,
    0,
    "the first send after an unpersisted interior chunk restarts from chunk 0 (tail discarded), not a mid-tail resume over the hole"
  );
});

test("ISS-6202: an accepted ack that confirms ZERO rows emits no Success and advances no accepted work", async () => {
  // The server ACCEPTS the envelope and echoes an empty `acceptedSessionIds` —
  // it persisted nothing (the live `isForeignChunk` skip reaches exactly this
  // shape). Before the guard, the same batch emitted the `ack_omitted` Failure
  // AND an unconditional batch-level Success, so a batch that persisted nothing
  // was reported as both a failure and forward progress, and the Success
  // advanced accepted sync burn-down for work no row acked.
  const TARGET = "target-iss-6202-empty-echo";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("s1", "2026-06-08T12:01:00.000Z"),
  ]);
  const telemetry: { sync: DesktopSyncBatchEventInput[] } = { sync: [] };
  const service = makeServiceWithIdentity(
    source,
    () => Promise.resolve({ accepted: true as const, acceptedSessionIds: [] }),
    TARGET,
    telemetry
  );

  service.start();
  // The REAL pass-completion signal, not one event-loop turn: ack processing
  // spans several async hops (the awaited durable clear among them), so a
  // fixed-turn flush leaves these assertions racing the pass (wongk review).
  await service.whenSessionSyncSettled();
  service.stop();

  assert.ok(
    !telemetry.sync.some(
      (event) => event.outcome === DesktopSyncBatchOutcome.Success
    ),
    "a batch the server confirmed nothing for must NOT report a Success outcome"
  );
  // The failure side is unchanged: the omission is still measured, so removing
  // the Success cannot make a zero-persistence batch silent.
  assert.deepEqual(
    telemetry.sync
      .filter((event) => event.reason === SyncReason.AckOmitted)
      .map((event) => event.outcome),
    [DesktopSyncBatchOutcome.Failure],
    "the omitted row still emits exactly one ack_omitted Failure event"
  );
  // ...and it is still measured AS A POST. Gating Success removed the only event
  // that carried this batch's bytes and round-trip time, so a run of zero-row
  // echoes would have burned wire and shown up free — hiding the resend
  // amplification `ack_omitted` exists to expose (wongk review). The omission
  // event is now the terminal event for the POST and carries its cost.
  const omittedEvent = telemetry.sync.find(
    (event) => event.reason === SyncReason.AckOmitted
  );
  assert.ok(
    (omittedEvent?.payloadBytes ?? 0) > 0,
    `the zero-row echo's only event must still carry the POST's payloadBytes, saw ${omittedEvent?.payloadBytes}`
  );
  assert.equal(
    typeof omittedEvent?.latencyMs,
    "number",
    "the zero-row echo's only event must still carry the POST's round-trip latencyMs"
  );
  assert.deepEqual(
    batchCostCarrierCounts(telemetry.sync),
    { bytes: 1, latency: 1 },
    "the POST's bytes and round-trip latency are reported exactly once — never dropped, never double-counted"
  );
  assert.deepEqual(
    source.pendingOutboxIds(key),
    ["s1"],
    "nothing was durably cleared — the unconfirmed row is still owed to the cloud"
  );
});

test("ISS-6202 control: a fully-confirmed ack still reports Success", async () => {
  // The counterfactual guard on the test above. Without this, the ISS-6202 fix
  // could pass by suppressing the Success event on every accepted batch, which
  // would stop accepted burn-down advancing at all.
  const TARGET = "target-iss-6202-full-echo";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("s1", "2026-06-08T12:01:00.000Z"),
  ]);
  const telemetry: { sync: DesktopSyncBatchEventInput[] } = { sync: [] };
  const service = makeServiceWithIdentity(
    source,
    (batch) =>
      Promise.resolve({
        accepted: true as const,
        acceptedSessionIds: batch.sessions.map((s) => s.externalSessionId),
      }),
    TARGET,
    telemetry
  );

  service.start();
  await service.whenSessionSyncSettled();
  service.stop();

  assert.ok(
    telemetry.sync.some(
      (event) => event.outcome === DesktopSyncBatchOutcome.Success
    ),
    "a batch whose rows the server confirmed still reports Success"
  );
  assert.deepEqual(
    batchCostCarrierCounts(telemetry.sync),
    { bytes: 1, latency: 1 },
    "the POST's bytes and round-trip latency are reported exactly once — never dropped, never double-counted"
  );
  assert.deepEqual(
    source.pendingOutboxIds(key),
    [],
    "the confirmed row was durably cleared"
  );
});

test("ISS-6202 (wongk review): a PARTIAL echo carries the POST's bytes and latency EXACTLY once — on the Success, never on the omission too", async () => {
  // The double-count direction of "exactly once". The acked row's Success is the
  // terminal event for this POST, so it carries the cost and the `ack_omitted`
  // event stays a pure per-row signal (`payloadBytes: 0`, no latency sample).
  //
  // COUNTERFACTUAL: make `foldOmittedRows` carry `input.payloadBytes` /
  // `input.latencyMs` unconditionally — the obvious way to "fix" the dropped
  // cost — and this batch's bytes are counted twice in burn-down while one round
  // trip enters the latency distribution as two samples. Both assertions below
  // fail.
  const TARGET = "target-iss-6202-partial-echo";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("s2", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("s1", "2026-06-08T12:01:00.000Z"),
  ]);
  const telemetry: { sync: DesktopSyncBatchEventInput[] } = { sync: [] };
  const service = makeServiceWithIdentity(
    source,
    (batch) =>
      Promise.resolve({
        accepted: true as const,
        // s2 persisted, s1 omitted — one batch, both dispositions.
        acceptedSessionIds: batch.sessions
          .map((s) => s.externalSessionId)
          .filter((id) => id !== "s1"),
      }),
    TARGET,
    telemetry
  );

  service.start();
  await service.whenSessionSyncSettled();
  service.stop();

  const omittedEvent = telemetry.sync.find(
    (event) => event.reason === SyncReason.AckOmitted
  );
  assert.ok(
    omittedEvent,
    "the omitted row must still emit its ack_omitted event"
  );
  assert.equal(
    omittedEvent.payloadBytes,
    0,
    "a per-row omission alongside an acked row must NOT re-report the batch's bytes"
  );
  assert.equal(
    omittedEvent.latencyMs,
    undefined,
    "one round trip must not enter the latency distribution twice"
  );
  assert.deepEqual(
    batchCostCarrierCounts(telemetry.sync),
    { bytes: 1, latency: 1 },
    "the POST's bytes and round-trip latency are reported exactly once — never dropped, never double-counted"
  );
  assert.deepEqual(
    source.pendingOutboxIds(key),
    ["s1"],
    "only the confirmed row cleared"
  );
});

/**
 * How many emitted events carried the POST's bytes, and how many carried its
 * round-trip latency. Compared against `{ bytes: 1, latency: 1 }` it fails in
 * BOTH directions — 0 when the fix drops the cost, 2 when a second event
 * re-reports it.
 */
function batchCostCarrierCounts(events: DesktopSyncBatchEventInput[]): {
  bytes: number;
  latency: number;
} {
  return {
    bytes: events.filter((event) => event.payloadBytes > 0).length,
    latency: events.filter((event) => event.latencyMs !== undefined).length,
  };
}
