import assert from "node:assert/strict";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, it } from "vitest";
import { buildAgentComponentInvocationSyncSourceKey } from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { AgentComponentInvocationSyncService } from "../src/main/agent-sync/agent-component-invocation-sync-service.js";
import { flush } from "./agent-session-sync-component-test-utils.js";
import {
  FakeSource,
  part,
  SESSION_MISSING_HORIZON_INTACT_AT,
  SESSION_MISSING_HORIZON_SPENT_AT,
} from "./helpers/invocation-sync-service-fixtures.js";

/**
 * An attempt count far past every ceiling the lane declares, so a case built on it
 * proves the terminal decision is NOT reading the shared `attempt_count` column.
 */
const ATTEMPTS_BEYOND_ANY_CEILING = 500;

describe("AgentComponentInvocationSyncService", () => {
  it("ISS-7980: reports a rejected refresh tick and permits the next scheduled attempt", async () => {
    const source = new FakeSource(part());
    source.entries = [];
    const tickError = new Error("promotion transaction rejected");
    let prepareAttempts = 0;
    source.prepareImpl = () => {
      prepareAttempts += 1;
      return Promise.reject(tickError);
    };
    const reported: unknown[] = [];
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async () => ({ kind: "unavailable", status: 404 }),
      onSyncError: (error) => reported.push(error),
    });

    service.start();
    try {
      await flush();
      assert.equal(prepareAttempts, 1);
      assert.deepEqual(reported, [tickError]);

      service.refresh();
      await flush();
      assert.equal(
        prepareAttempts,
        2,
        "a caught rejection must clear single-flight state for the next tick"
      );
      assert.deepEqual(reported, [tickError, tickError]);
    } finally {
      service.stop();
    }
  });

  it("ISS-7980: contains a throwing sync-error reporter and keeps later ticks usable", async () => {
    const source = new FakeSource(part());
    source.entries = [];
    let prepareAttempts = 0;
    source.prepareImpl = () => {
      prepareAttempts += 1;
      return Promise.reject(new Error(`prepare-${prepareAttempts}`));
    };
    let reportAttempts = 0;
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async () => ({ kind: "unavailable", status: 404 }),
      onSyncError: () => {
        reportAttempts += 1;
        throw new Error("reporter unavailable");
      },
    });

    service.start();
    try {
      await flush();
      assert.equal(prepareAttempts, 1);
      assert.equal(reportAttempts, 1);

      service.refresh();
      await flush();
      assert.equal(prepareAttempts, 2);
      assert.equal(
        reportAttempts,
        2,
        "a reporter failure must not strand the service's single-flight task"
      );
    } finally {
      service.stop();
    }
  });

  it("ISS-7980: keeps the error reporter optional for existing callers", async () => {
    const source = new FakeSource(part());
    source.entries = [];
    let prepareAttempts = 0;
    source.prepareImpl = () => {
      prepareAttempts += 1;
      return Promise.reject(new Error(`prepare-${prepareAttempts}`));
    };
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async () => ({ kind: "unavailable", status: 404 }),
    });

    service.start();
    try {
      await flush();
      assert.equal(prepareAttempts, 1);

      service.refresh();
      await flush();
      assert.equal(prepareAttempts, 2);
    } finally {
      service.stop();
    }
  });

  it("clears only an exact accepted part acknowledgement", async () => {
    const source = new FakeSource(part());
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async (pending) => ({
        kind: "ack",
        ack: {
          accepted: true,
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          state: AgentComponentInvocationSyncAckState.Activated,
        },
      }),
    });

    await service.syncOnce();

    assert.equal(source.entries.length, 0);
    assert.equal(source.clearCalls, 1);
  });

  it("PRD-699: recovers target-scoped dead letters before loading ready parts", async () => {
    const source = new FakeSource(part());
    const targetSourceKey =
      buildAgentComponentInvocationSyncSourceKey("target-1");
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async (pending) => ({
        kind: "ack",
        ack: {
          accepted: true,
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          state: AgentComponentInvocationSyncAckState.Activated,
        },
      }),
    });

    await service.syncOnce();

    assert.equal(source.recoverCalls, 1);
    assert.deepEqual(source.recoveredSourceKeys, [targetSourceKey]);
    assert.deepEqual(source.callOrder.slice(0, 2), [
      `recover:${targetSourceKey}`,
      `load:${targetSourceKey}`,
    ]);
  });

  it("PRD-699: rechecks the target after dead-letter recovery before loading or preparing", async () => {
    const source = new FakeSource(part());
    source.entries = [];
    let target = "target-1";
    let sends = 0;
    let prepareEntered = false;
    source.prepareImpl = () => {
      prepareEntered = true;
      return Promise.resolve();
    };
    source.recoverImpl = () => {
      target = "target-2";
      return Promise.resolve({
        recoveredParts: 1,
        cappedParts: 0,
        quarantinedParts: 0,
      });
    };
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => target,
      sendPart: () => {
        sends += 1;
        return Promise.resolve({ kind: "unavailable" as const, status: 404 });
      },
    });

    await service.syncOnce();

    assert.deepEqual(source.callOrder, [
      `recover:${buildAgentComponentInvocationSyncSourceKey("target-1")}`,
    ]);
    assert.equal(prepareEntered, false);
    assert.equal(sends, 0);
  });

  it("PRD-699: suppresses unchanged capped dead-letter recovery logs", async () => {
    const source = new FakeSource(part());
    source.entries = [];
    source.recoverResult = {
      recoveredParts: 0,
      cappedParts: 1,
      quarantinedParts: 0,
    };
    const logs: string[] = [];
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      log: (message) => logs.push(message),
      sendPart: () => Promise.resolve({ kind: "unavailable" as const }),
    });

    await service.syncOnce();
    await service.syncOnce();
    source.recoverResult = {
      recoveredParts: 0,
      cappedParts: 2,
      quarantinedParts: 0,
    };
    await service.syncOnce();

    assert.deepEqual(
      logs.filter((message) =>
        message.startsWith("invocation dead-letter recovery pass")
      ),
      [
        "invocation dead-letter recovery pass: sourceKey=agent_component_invocations:target-1 recovered=0 capped=1 quarantined=0",
        "invocation dead-letter recovery pass: sourceKey=agent_component_invocations:target-1 recovered=0 capped=2 quarantined=0",
      ]
    );
  });

  it("retains an exact part across unavailable API and service restart", async () => {
    const source = new FakeSource(part());
    const first = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async () => ({ kind: "unavailable", status: 404 }),
      now: () => new Date("2026-07-22T16:00:00.000Z"),
    });

    await first.syncOnce();
    assert.equal(source.entries.length, 1);
    assert.equal(source.entries[0].attemptCount, 0);
    assert.equal(
      source.entries[0].laneStalledSince,
      "2026-07-22T16:00:00.000Z"
    );

    const resumed = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async (pending) => ({
        kind: "ack",
        ack: {
          accepted: true,
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          state: AgentComponentInvocationSyncAckState.Stale,
        },
      }),
      now: () => new Date("2026-07-22T16:06:00.000Z"),
    });
    await resumed.syncOnce();

    assert.equal(source.entries.length, 0);
  });

  it("does not advance on an acknowledgement for a different part", async () => {
    const source = new FakeSource(part());
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async (pending) => ({
        kind: "ack",
        ack: {
          accepted: true,
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: "b".repeat(64),
          state: AgentComponentInvocationSyncAckState.Staged,
        },
      }),
      now: () => new Date("2026-07-22T16:00:00.000Z"),
    });

    await service.syncOnce();

    assert.equal(source.entries.length, 1);
    assert.equal(source.entries[0].attemptCount, 0);
    assert.equal(
      source.entries[0].laneStalledSince,
      "2026-07-22T16:00:00.000Z"
    );
    assert.equal(source.clearCalls, 0);
  });

  it("ISS-4710: sends already-materialized ready parts WITHOUT awaiting a writer-busy prepare (single-flight preserved)", async () => {
    // Root-cause regression: `prepareInvocationSyncTarget` is a heavy
    // `prisma.write` `$transaction`. Running it FIRST every tick parks the whole
    // component lane behind the writer during a first-boot DATA_REVISION rebuild,
    // so ready parts never upload. With ready parts already materialized, the tick
    // must load + send them and NOT block on the (writer-busy) prepare.
    const source = new FakeSource(part());
    // The prepare parks forever (models the writer saturated by the rebuild) and
    // records whether it was ever entered this tick.
    let prepareEntered = false;
    const heldPrepare = new Promise<void>(() => undefined);
    source.prepareImpl = () => {
      prepareEntered = true;
      return heldPrepare;
    };

    const sent: AgentComponentInvocationSyncPart[] = [];
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: (pending) => {
        sent.push(pending);
        return Promise.resolve({
          kind: "ack",
          ack: {
            accepted: true,
            protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
            externalGenerationId: pending.externalGenerationId,
            partIndex: pending.partIndex,
            partHash: pending.partHash,
            state: AgentComponentInvocationSyncAckState.Activated,
          },
        });
      },
    });

    // `syncOnce` resolves — it did NOT hang on the parked prepare — and the ready
    // part was uploaded and cleared.
    await service.syncOnce();

    assert.equal(sent.length, 1, "the ready part was sent while writer busy");
    assert.equal(
      prepareEntered,
      false,
      "the heavy prepare was deferred because ready parts were present"
    );
    assert.equal(source.clearCalls, 1, "the acked part was cleared");
    assert.equal(source.entries.length, 0);
  });

  it("ISS-4710: runs the prepare only when NO ready parts are already materialized", async () => {
    // The complement: with an empty outbox the tick MUST run prepare to
    // materialize the next batch (otherwise nothing would ever be enqueued).
    const source = new FakeSource(part());
    // Start with no ready parts; prepare "materializes" the pending entry.
    const pendingPart = source.entries[0];
    source.entries = [];
    let prepareEntered = false;
    source.prepareImpl = () => {
      prepareEntered = true;
      source.entries = [pendingPart];
      return Promise.resolve();
    };

    const sent: AgentComponentInvocationSyncPart[] = [];
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: (pending) => {
        sent.push(pending);
        return Promise.resolve({
          kind: "ack",
          ack: {
            accepted: true,
            protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
            externalGenerationId: pending.externalGenerationId,
            partIndex: pending.partIndex,
            partHash: pending.partHash,
            state: AgentComponentInvocationSyncAckState.Activated,
          },
        });
      },
    });

    await service.syncOnce();

    assert.equal(prepareEntered, true, "prepare ran to materialize a batch");
    assert.equal(sent.length, 1, "the freshly-materialized part was sent");
    assert.equal(source.entries.length, 0);
  });

  it("dead-letters a permanently rejected exact part after the retry threshold", async () => {
    const source = new FakeSource(part(), 4).withPermanentAttemptCount(4);
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async (pending) => ({
        kind: "ack",
        ack: {
          accepted: false,
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          reason: AgentComponentInvocationSyncRejectReason.ValidationFailed,
        },
      }),
    });

    await service.syncOnce();

    assert.equal(source.entries.length, 0);
    assert.equal(source.deadLetterCalls, 1);
    assert.equal(source.deadLetteredAttemptCount, 4);
    assert.equal(source.deadLetteredPermanentAttemptCount, 5);
  });

  // ISS-5347: a dead-lettered invocation part used to disappear without a trace —
  // `deadLetterInvocationSyncPart`'s own result was discarded and nothing logged.
  // That is how a stranded part 6-of-7 sat undetected on a live install while
  // `sync_state.dead_lettered_ids` read `[]` for BOTH cursors: that column belongs
  // to the session and component-INVENTORY lanes and never covers this one, whose
  // record is the outbox `status` column. The two records could not agree, and
  // only one of them was reported. This lane now reports its own.
  it("ISS-5347: surfaces a dead-lettered part instead of abandoning it silently", async () => {
    const source = new FakeSource(part(), 4).withPermanentAttemptCount(4);
    const logs: string[] = [];
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      log: (message) => logs.push(message),
      sendPart: async (pending) => ({
        kind: "ack",
        ack: {
          accepted: false,
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          reason: AgentComponentInvocationSyncRejectReason.ValidationFailed,
        },
      }),
    });

    assert.equal(
      service.deadLetteredPartCount,
      0,
      "no parts are dead-lettered before the drain runs"
    );

    await service.syncOnce();

    assert.equal(
      service.deadLetteredPartCount,
      1,
      "the lane must count the part it gave up on"
    );
    assert.equal(
      logs.some((m) => m.includes("eligible for in-place recovery")),
      true,
      `the abandonment must name its recovery state, got: ${JSON.stringify(logs)}`
    );
    assert.equal(
      logs.some((m) =>
        m.includes(AgentComponentInvocationSyncRejectReason.ValidationFailed)
      ),
      true,
      "the report must carry the rejection reason so the stranded part is actionable"
    );
  });

  // ISS-5347: the counter is a QUALITY SIGNAL, so it must increment only where its
  // precondition held. A dead-letter write that matched no row (the part was
  // already cleared or superseded) must not inflate it.
  it("ISS-5347: does not count a dead-letter write that matched no outbox row", async () => {
    const source = new FakeSource(part(), 4).withPermanentAttemptCount(4);
    source.deadLetterInvocationSyncPart = () => Promise.resolve(false);
    const logs: string[] = [];
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      log: (message) => logs.push(message),
      sendPart: async (pending) => ({
        kind: "ack",
        ack: {
          accepted: false,
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          reason: AgentComponentInvocationSyncRejectReason.ValidationFailed,
        },
      }),
    });

    await service.syncOnce();

    assert.equal(
      service.deadLetteredPartCount,
      0,
      "a no-op dead-letter write must not be reported as an abandoned part"
    );
    assert.equal(
      logs.some((m) => m.includes("invocation part dead-lettered")),
      false,
      "nothing was abandoned, so nothing should be reported"
    );
  });

  // ISS-5347 (whitlockk review): the counter and its log line both say "this run", so
  // a `stop()` must clear it with the rest of the accumulated lifecycle state.
  // Without that, restarting the SAME service instance reports the previous
  // lifecycle's strandings as current and the next abandonment's log line counts
  // from the wrong base.
  it("ISS-5347: stop() clears the dead-letter count so a restarted instance does not report the prior run's parts", async () => {
    const source = new FakeSource(part(), 4).withPermanentAttemptCount(4);
    const logs: string[] = [];
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      log: (message) => logs.push(message),
      sendPart: async (pending) => ({
        kind: "ack",
        ack: {
          accepted: false,
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          reason: AgentComponentInvocationSyncRejectReason.ValidationFailed,
        },
      }),
    });

    await service.syncOnce();
    assert.equal(
      service.deadLetteredPartCount,
      1,
      "sanity: the first lifecycle abandoned one part"
    );

    service.stop();

    assert.equal(
      service.deadLetteredPartCount,
      0,
      "stop() must clear the per-run dead-letter count"
    );

    // A second lifecycle on the SAME instance abandons one more part. It must
    // report ONE, not two.
    source.entries.push({
      part: part("d".repeat(64)),
      attemptCount: 4,
      permanentAttemptCount: 4,
      deadLetterRecoveryCount: 0,
      laneStalledSince: null,
      nextAttemptAt: null,
    });
    logs.length = 0;
    await service.syncOnce();

    assert.equal(
      service.deadLetteredPartCount,
      1,
      "the restarted lifecycle counts only its own abandoned part"
    );
    assert.equal(
      logs.some((m) => m.includes("dead-lettered parts this run: 1")),
      true,
      `the report must count from the restarted lifecycle, got: ${JSON.stringify(logs)}`
    );
  });

  // ISS-4623 (whitlockk review): the readiness gate ANDs the fail-closed
  // readiness gate, and the compute target was captured once at entry.
  // A gate-close (policy true→false) or account switch that lands DURING the
  // drain must halt egress before the next send — not keep POSTing under a
  // just-closed gate or a switched target.
  it("stops sending the moment the readiness gate closes mid-drain", async () => {
    const source = new FakeSource(part(), 0, part("d".repeat(64)));
    let ready = true;
    let sends = 0;
    const service = new AgentComponentInvocationSyncService({
      // Gate is open at entry; it closes after the first send lands (e.g. the
      // readiness gate closed while the first part was in flight).
      isReady: () => ready,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: (pending) => {
        sends += 1;
        ready = false;
        return Promise.resolve({
          kind: "ack" as const,
          ack: {
            accepted: true,
            protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
            externalGenerationId: pending.externalGenerationId,
            partIndex: pending.partIndex,
            partHash: pending.partHash,
            state: AgentComponentInvocationSyncAckState.Activated,
          },
        });
      },
    });

    await service.syncOnce();

    // Only the first part was sent; the closed gate halted the second send.
    assert.equal(sends, 1);
    assert.equal(source.entries.length, 1);
  });

  it("stops sending when the compute target switches mid-drain", async () => {
    const source = new FakeSource(part(), 0, part("d".repeat(64)));
    let target = "target-1";
    let sends = 0;
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      // The account switches after the first send: the drain was scoped to
      // "target-1", so the second part must not be sent under "target-2".
      getComputeTargetId: () => target,
      sendPart: (pending) => {
        sends += 1;
        target = "target-2";
        return Promise.resolve({
          kind: "ack" as const,
          ack: {
            accepted: true,
            protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
            externalGenerationId: pending.externalGenerationId,
            partIndex: pending.partIndex,
            partHash: pending.partHash,
            state: AgentComponentInvocationSyncAckState.Activated,
          },
        });
      },
    });

    await service.syncOnce();

    assert.equal(sends, 1);
    assert.equal(source.entries.length, 1);
  });

  it("does not send at all when the gate closes during background-slot wait", async () => {
    const source = new FakeSource(part());
    let ready = true;
    let sends = 0;
    const service = new AgentComponentInvocationSyncService({
      isReady: () => ready,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      // The gate closes while the drain is parked on the background slot, before
      // any outbox read or send.
      waitForBackgroundSlot: () => {
        ready = false;
        return Promise.resolve();
      },
      sendPart: () => {
        sends += 1;
        return Promise.resolve({ kind: "unavailable" as const, status: 404 });
      },
    });

    await service.syncOnce();

    assert.equal(sends, 0);
    assert.equal(source.entries.length, 1);
  });

  // ISS-5789 (PRD-634/PRD-635). `session_missing` was absent from the permanent
  // classification, so an orphaned part retried forever — 729 attempts since July
  // 27 on the reported install — and everything behind it stayed stuck.
  it("ISS-5789: dead-letters an exhausted session_missing part and drains the next one", async () => {
    const orphan = part();
    const healthy = part("d".repeat(64));
    // ISS-5789: `session_missing` is budgeted by how long the part has been
    // retrying, so what makes this orphan terminal is its AGE — the clock below —
    // and not a pre-loaded attempt count.
    const source = new FakeSource(orphan, 0, healthy);
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: (pending) =>
        Promise.resolve(
          pending.partHash === orphan.partHash
            ? {
                kind: "ack" as const,
                ack: {
                  accepted: false as const,
                  protocolVersion:
                    AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
                  externalGenerationId: pending.externalGenerationId,
                  partIndex: pending.partIndex,
                  partHash: pending.partHash,
                  reason:
                    AgentComponentInvocationSyncRejectReason.SessionMissing,
                },
              }
            : {
                kind: "ack" as const,
                ack: {
                  accepted: true as const,
                  protocolVersion:
                    AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
                  externalGenerationId: pending.externalGenerationId,
                  partIndex: pending.partIndex,
                  partHash: pending.partHash,
                  state: AgentComponentInvocationSyncAckState.Activated,
                },
              }
        ),
      now: () => new Date(SESSION_MISSING_HORIZON_SPENT_AT),
    });

    await service.syncOnce();

    assert.equal(
      source.deadLetterCalls,
      1,
      "an exhausted session_missing part must stop retrying"
    );
    // The unblock is the actual outcome PRD-634 asked for: the jammed item must
    // not merely stop retrying, the queue behind it must move.
    assert.equal(
      source.clearCalls,
      1,
      "the item queued behind the jam must be attempted and accepted"
    );
    assert.deepEqual(
      source.entries,
      [],
      "neither the jammed part nor the one behind it may remain queued"
    );
  });

  // The test that stops the fix passing by making everything permanent.
  it("ISS-5789: keeps retrying a rate-limited part however long it has failed", async () => {
    const source = new FakeSource(part(), 40);
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: (pending) =>
        Promise.resolve({
          kind: "ack" as const,
          ack: {
            accepted: false as const,
            protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
            externalGenerationId: pending.externalGenerationId,
            partIndex: pending.partIndex,
            partHash: pending.partHash,
            reason: AgentComponentInvocationSyncRejectReason.RateLimited,
          },
        }),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    await service.syncOnce();

    assert.equal(
      source.deadLetterCalls,
      0,
      "a rate limit is lane-wide and must never exhaust a row's budget"
    );
    assert.equal(source.entries.length, 1);
  });

  // ISS-5789, the shared-counter hazard (`main/sync/AGENTS.md` invariant 4's KNOWN
  // GAP), driven ADVERSARIALLY. `attemptCount` is the SAME column every transient
  // failure bumps, so any budget read off that column lets an outage's own retries
  // strand a healthy part on the very first sight of the reason. The count here is
  // deliberately far PAST every
  // attempt ceiling the lane declares: if the budget were an attempt count, this
  // case would dead-letter no matter how large that count was.
  it("ISS-5789: an outage's transient retries do not strand a part on its first session_missing", async () => {
    const source = new FakeSource(part(), ATTEMPTS_BEYOND_ANY_CEILING);
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: (pending) =>
        Promise.resolve({
          kind: "ack" as const,
          ack: {
            accepted: false as const,
            protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
            externalGenerationId: pending.externalGenerationId,
            partIndex: pending.partIndex,
            partHash: pending.partHash,
            reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
          },
        }),
      now: () => new Date(SESSION_MISSING_HORIZON_INTACT_AT),
    });

    await service.syncOnce();

    assert.equal(
      source.deadLetterCalls,
      0,
      "a lane-wide outage's retries must never spend the session_missing budget"
    );
    assert.equal(source.entries.length, 1);
    assert.equal(
      source.entries[0]?.attemptCount,
      ATTEMPTS_BEYOND_ANY_CEILING + 1,
      "the row-local ordering retry is still charged; only the permanent counter stays untouched"
    );
  });
});

/**
 * ISS-5973: promotion must not be starved by a permanently-ready part.
 *
 * The fixture carries the STALLING condition measured on the live install: a part
 * that never settles and is ready again on every tick (its backoff always elapsed
 * by the time the next tick samples the clock), so `loadReadyInvocationSyncParts`
 * never returns an empty set. Under the pre-ISS-5973 gate — `if (entries.length
 * === 0)` — that suppressed `prepareInvocationSyncTarget` FOREVER, and no session
 * was ever promoted from the template key into the delivery queue again.
 *
 * A fixture whose queue drains to empty exercises the fast path instead and
 * passes with or without the fix.
 */
describe("ISS-5973 promotion starvation", () => {
  const TICK_MS = 60 * 60 * 1000;
  const START_MS = Date.parse("2026-08-11T00:00:00.000Z");

  it("eventually promotes even while a part is permanently ready", async () => {
    const source = new FakeSource(part());
    const inFlight = source.entries[0];
    let prepareCalls = 0;
    // Promotion MATERIALIZES delivery rows, so the fake models that: it appends a
    // freshly promoted part. Without this the queue would be invariant no matter
    // what the escape did, and the "no row lost" assertion below could not fail.
    source.prepareImpl = () => {
      prepareCalls += 1;
      source.entries.push({
        part: part("d".repeat(64)),
        attemptCount: 0,
        permanentAttemptCount: 0,
        deadLetterRecoveryCount: 0,
        laneStalledSince: null,
        nextAttemptAt: null,
      });
      return Promise.resolve();
    };
    let tick = 0;
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      // Never settles, never dead-letters: the row is deferred and is ready
      // again on the next tick, exactly like the 14 `session_missing` rows the
      // live install was re-arming indefinitely.
      sendPart: async () => ({ kind: "unavailable", status: 404 }),
      now: () => new Date(START_MS + tick * TICK_MS),
    });

    for (tick = 0; tick < 20; tick += 1) {
      await service.syncOnce();
    }

    assert.ok(
      prepareCalls >= 1,
      `promotion never ran across 20 ticks (prepareCalls=${prepareCalls}) — the delivery queue can never be refilled`
    );
    // AC3: the escape only ADMITS work. The originally-queued part is still in
    // the queue, and the promoted part joined it — nothing was dropped to make
    // the lane move.
    assert.ok(
      source.entries.includes(inFlight),
      "the in-flight part was dropped from the queue by the promotion escape"
    );
    assert.equal(source.entries.length, 1 + prepareCalls);
    // And the escape must not restart the in-flight row's lane-stall clock out
    // from under it — that would make invariant 5's terminal path unreachable.
    assert.equal(
      inFlight.laneStalledSince,
      new Date(START_MS).toISOString(),
      "the in-flight part's lane-stall clock was reset by promotion"
    );
  });

  it("keeps the fast path: a tick with ready work does not prepare every time", async () => {
    const source = new FakeSource(part());
    let prepareCalls = 0;
    source.prepareImpl = () => {
      prepareCalls += 1;
      return Promise.resolve();
    };
    let tick = 0;
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async () => ({ kind: "unavailable", status: 404 }),
      now: () => new Date(START_MS + tick * TICK_MS),
    });

    for (tick = 0; tick < 3; tick += 1) {
      await service.syncOnce();
    }

    // ISS-4710's deferral is intact for the ordinary case — three busy ticks in
    // a row must not each pay for the heavy prepare `$transaction`.
    assert.equal(prepareCalls, 0);
  });

  // ISS-8691 (#6351) made ready-with-no-target reachable for the FIRST time on
  // this lane: `isHttpAgentSessionSyncReady` became retained-aware, while this
  // lane's target stayed the strict-online `getTranscriptComputeTargetId`. So a
  // socket-down window now has `isReady()` true and the target null — a pairing
  // the two gates could never produce before. Loosening the target is ISS-8687's
  // call; what this pins is that the asymmetry is inert, so nobody reads the
  // combination as a crash or as a send addressed to no one.
  it("ISS-8691: ready with no compute target is a clean no-op, not a send", async () => {
    const source = new FakeSource(part());
    let prepareCalls = 0;
    source.prepareImpl = () => {
      prepareCalls += 1;
      return Promise.resolve();
    };
    let sends = 0;
    const errors: unknown[] = [];
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => null,
      sendPart: () => {
        sends += 1;
        return Promise.resolve({ kind: "unavailable" as const, status: 404 });
      },
      onSyncError: (error) => errors.push(error),
    });

    await service.syncOnce();

    assert.equal(
      sends,
      0,
      "with no target there is nothing to address a part to"
    );
    assert.equal(
      prepareCalls,
      0,
      "the lane must stop before the heavy prepare"
    );
    assert.deepEqual(errors, [], "the asymmetry must not surface as an error");
  });
});
