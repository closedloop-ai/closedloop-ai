import assert from "node:assert/strict";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, it } from "vitest";
import { AgentComponentInvocationSyncLocalError } from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { AgentComponentInvocationSyncService } from "../src/main/agent-sync/agent-component-invocation-sync-service.js";
import {
  FakeSource,
  part,
} from "./helpers/invocation-sync-service-fixtures.js";

const NOW_ISO = "2026-08-14T16:00:00.000Z";

describe("invocation sync ack mismatch retry budget", () => {
  it("retries an ack mismatch through the environmental stall clock", async () => {
    const source = new FakeSource(part(), 5).withPermanentAttemptCount(2);
    const service = ackMismatchService(source);

    await service.syncOnce();

    assert.equal(source.deadLetterCalls, 0);
    assert.equal(source.entries[0].attemptCount, 5);
    assert.equal(source.entries[0].permanentAttemptCount, 2);
    assert.equal(source.entries[0].laneStalledSince, NOW_ISO);
    assert.equal(source.entries[0].nextAttemptAt, "2026-08-14T16:05:00.000Z");
  });

  it("dead-letters ack mismatch only after the environmental stall ceiling", async () => {
    const source = new FakeSource(part(), 5).withPermanentAttemptCount(2);
    source.entries[0].laneStalledSince = "2026-08-13T15:59:59.000Z";
    const logs: string[] = [];
    const service = ackMismatchService(source, logs);

    await service.syncOnce();

    assert.equal(source.deadLetterCalls, 1);
    assert.equal(source.deadLetteredAttemptCount, 5);
    assert.equal(source.deadLetteredPermanentAttemptCount, 2);
    assert.equal(
      source.deadLetteredError,
      AgentComponentInvocationSyncLocalError.EnvironmentalStallExhausted
    );
    assert.equal(
      logs.some((message) =>
        message.includes("eligible for in-place recovery")
      ),
      true,
      `ack mismatch terminal path must advertise recovery, got: ${JSON.stringify(logs)}`
    );
  });
});

function ackMismatchService(
  source: FakeSource,
  logs: string[] = []
): AgentComponentInvocationSyncService {
  return new AgentComponentInvocationSyncService({
    isReady: () => true,
    getSource: () => source,
    getComputeTargetId: () => "target-1",
    log: (message) => logs.push(message),
    sendPart: async (pending) => ({
      kind: "ack" as const,
      ack: {
        accepted: true as const,
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        externalGenerationId: pending.externalGenerationId,
        partIndex: pending.partIndex,
        partHash: `${pending.partHash}:unexpected`,
        state: AgentComponentInvocationSyncAckState.Activated,
      },
    }),
    now: () => new Date(NOW_ISO),
  });
}
