import assert from "node:assert/strict";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, it } from "vitest";
import { AgentComponentInvocationSyncLocalError } from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { AgentComponentInvocationSyncService } from "../src/main/agent-sync/agent-component-invocation-sync-service.js";
import { LANE_STALL_CEILING_MS } from "../src/shared/lane-stall-clock.js";
import {
  FakeSource,
  part,
} from "./helpers/invocation-sync-service-fixtures.js";

const START_ISO = "2026-08-14T16:00:00.000Z";
const START_MS = Date.parse(START_ISO);

describe("PRD-699 invocation sync durability", () => {
  it("uses the durable lane-stall clock for transport retries without burning row counters", async () => {
    const source = new FakeSource(part(), 7);
    source.entries[0].permanentAttemptCount = 4;
    let nowMs = START_MS;
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async () => ({
        kind: "retry",
        status: 401,
        error: "invocation sync returned HTTP 401",
      }),
      now: () => new Date(nowMs),
    });

    await service.syncOnce();

    assert.equal(source.entries[0].attemptCount, 7);
    assert.equal(source.entries[0].permanentAttemptCount, 4);
    assert.equal(source.entries[0].laneStalledSince, START_ISO);
    assert.equal(source.entries[0].nextAttemptAt, "2026-08-14T16:05:00.000Z");

    nowMs = Date.parse("2026-08-14T16:10:00.000Z");
    await service.syncOnce();

    assert.equal(source.entries[0].attemptCount, 7);
    assert.equal(source.entries[0].permanentAttemptCount, 4);
    assert.equal(
      source.entries[0].laneStalledSince,
      START_ISO,
      "the persisted stall origin must not restart on each retry"
    );
    assert.equal(source.entries[0].nextAttemptAt, "2026-08-14T16:20:00.000Z");
  });

  it("honors Retry-After as a minimum in the environmental stall schedule", async () => {
    const source = new FakeSource(part(), 3);
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: async () => ({
        kind: "retry",
        status: 503,
        error: "invocation sync returned HTTP 503",
        retryAfterMs: 60 * 60_000,
      }),
      now: () => new Date(START_ISO),
    });

    await service.syncOnce();

    assert.equal(source.entries[0].attemptCount, 3);
    assert.equal(source.entries[0].laneStalledSince, START_ISO);
    assert.equal(source.entries[0].nextAttemptAt, "2026-08-14T17:00:00.000Z");
  });

  it("quarantines malformed lane_stalled_since instead of reopening the stall clock", async () => {
    const source = new FakeSource(part(), 3);
    source.entries[0].laneStalledSince = "not-an-instant";
    const logs: string[] = [];
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      log: (message) => logs.push(message),
      sendPart: async () => ({
        kind: "retry",
        status: 503,
        error: "invocation sync returned HTTP 503",
      }),
      now: () => new Date(START_ISO),
    });

    await service.syncOnce();

    assert.equal(source.deadLetterCalls, 1);
    assert.equal(source.deadLetteredAttemptCount, 3);
    assert.equal(
      source.deadLetteredError,
      AgentComponentInvocationSyncLocalError.InvalidPersistedDurabilityState
    );
    assert.equal(
      logs.some((message) => message.includes("lane_stalled_since")),
      true,
      `bad-data log must name the corrupt column, got: ${JSON.stringify(logs)}`
    );
  });

  it("routes environmental ack reasons to the stall clock instead of attempt_count", async () => {
    const source = new FakeSource(part(), 500);
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
          reason: AgentComponentInvocationSyncRejectReason.RateLimited,
        },
      }),
      now: () => new Date(START_ISO),
    });

    await service.syncOnce();

    assert.equal(source.deadLetterCalls, 0);
    assert.equal(source.entries[0].attemptCount, 500);
    assert.equal(source.entries[0].permanentAttemptCount, 0);
    assert.equal(source.entries[0].laneStalledSince, START_ISO);
  });

  it("charges permanent rejections against permanent_attempt_count only", async () => {
    const source = new FakeSource(part(), 500);
    const service = validationFailureService(source, START_ISO);

    await service.syncOnce();

    assert.equal(source.deadLetterCalls, 0);
    assert.equal(source.entries[0].attemptCount, 500);
    assert.equal(source.entries[0].permanentAttemptCount, 1);

    source.entries[0].nextAttemptAt = null;
    source.entries[0].permanentAttemptCount = 4;
    await service.syncOnce();

    assert.equal(source.deadLetterCalls, 1);
    assert.equal(source.deadLetteredAttemptCount, 500);
    assert.equal(source.deadLetteredPermanentAttemptCount, 5);
  });

  it("dead-letters a lane-wide stall at the wall-clock ceiling without burning counters", async () => {
    const source = new FakeSource(part(), 3);
    source.entries[0].laneStalledSince = new Date(
      START_MS - LANE_STALL_CEILING_MS
    ).toISOString();
    const logs: string[] = [];
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      log: (message) => logs.push(message),
      sendPart: async () => ({
        kind: "retry",
        status: 403,
        error: "invocation sync returned HTTP 403",
      }),
      now: () => new Date(START_ISO),
    });

    await service.syncOnce();

    assert.equal(source.deadLetterCalls, 1);
    assert.equal(source.deadLetteredAttemptCount, 3);
    assert.equal(source.deadLetteredPermanentAttemptCount, 0);
    assert.equal(
      source.deadLetteredError,
      AgentComponentInvocationSyncLocalError.EnvironmentalStallExhausted
    );
    assert.equal(
      logs.some((message) =>
        message.includes("eligible for in-place recovery")
      ),
      true,
      `environmental give-up must advertise the recovery door, got: ${JSON.stringify(logs)}`
    );
  });
});

function validationFailureService(
  source: FakeSource,
  nowIso: string
): AgentComponentInvocationSyncService {
  return new AgentComponentInvocationSyncService({
    isReady: () => true,
    getSource: () => source,
    getComputeTargetId: () => "target-1",
    sendPart: async (pending) => ({
      kind: "ack" as const,
      ack: {
        accepted: false as const,
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        externalGenerationId: pending.externalGenerationId,
        partIndex: pending.partIndex,
        partHash: pending.partHash,
        reason: AgentComponentInvocationSyncRejectReason.ValidationFailed,
      },
    }),
    now: () => new Date(nowIso),
  });
}
