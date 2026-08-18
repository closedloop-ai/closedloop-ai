import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { vi } from "vitest";
import {
  handlePreparationFailures,
  prepareCandidatePayloadsIsolated,
} from "../src/main/agent-sync/agent-session-payload-preparation.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type {
  AgentSessionPayloadPreparer,
  PreparedAgentSessionPayload,
} from "../src/main/agent-sync/agent-session-sync-payload.js";
import { DesktopSyncBatchOutcome } from "../src/main/telemetry/app-otel-runtime.js";

const MAX_BYTES = 1_000_000;

function makeSession(id: string): SyncedAgentSession {
  return {
    externalSessionId: id,
    status: "completed",
    harness: "codex",
    cwd: `/workspace/${id}`,
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt: "2026-06-08T12:01:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}

function sessionPayload(id: string): PreparedAgentSessionPayload {
  return { kind: "session", session: makeSession(id), payloadBytes: 100 };
}

describe("prepareCandidatePayloadsIsolated", () => {
  test("returns the batched payloads unchanged when the whole batch prepares", async () => {
    const sessions = [makeSession("a"), makeSession("b")];
    const batchPayloads = [sessionPayload("a"), sessionPayload("b")];
    const preparePayloads = vi.fn<AgentSessionPayloadPreparer>(() =>
      Promise.resolve(batchPayloads)
    );

    const result = await prepareCandidatePayloadsIsolated(
      preparePayloads,
      sessions,
      MAX_BYTES
    );

    assert.strictEqual(result.prepared, batchPayloads);
    assert.deepEqual(result.failures, []);
    assert.strictEqual(
      preparePayloads.mock.calls.length,
      1,
      "the happy path takes exactly one round-trip (no per-session retry)"
    );
  });

  test("isolates the single failing session and preserves healthy siblings", async () => {
    const sessions = [
      makeSession("ok-1"),
      makeSession("boom"),
      makeSession("ok-2"),
    ];
    const preparePayloads = vi.fn<AgentSessionPayloadPreparer>(
      (batch: SyncedAgentSession[]) => {
        // The whole-batch attempt rejects because "boom" is present.
        if (batch.length > 1) {
          return Promise.reject(new Error("worker timed out"));
        }
        if (batch[0]?.externalSessionId === "boom") {
          return Promise.reject(new Error("worker timed out"));
        }
        return Promise.resolve([sessionPayload(batch[0].externalSessionId)]);
      }
    );

    const result = await prepareCandidatePayloadsIsolated(
      preparePayloads,
      sessions,
      MAX_BYTES
    );

    // Only "boom" is charged; both healthy siblings still prepared this pass.
    assert.deepEqual(
      result.failures.map((f) => f.session.externalSessionId),
      ["boom"],
      "only the actual offender is reported as failed"
    );
    assert.deepEqual(
      result.prepared.map((p) =>
        p.kind === "session" ? p.session.externalSessionId : p.kind
      ),
      ["ok-1", "ok-2"],
      "healthy siblings are not dead-lettered — they prepared for this pass"
    );
  });

  test("reports every session when the whole batch fails per-session too", async () => {
    const sessions = [makeSession("a"), makeSession("b")];
    const preparePayloads = vi.fn<AgentSessionPayloadPreparer>(() =>
      Promise.reject(new Error("worker exploded"))
    );

    const result = await prepareCandidatePayloadsIsolated(
      preparePayloads,
      sessions,
      MAX_BYTES
    );

    assert.deepEqual(result.prepared, []);
    assert.deepEqual(
      result.failures.map((f) => f.session.externalSessionId),
      ["a", "b"]
    );
  });

  test("a single-session batch failure is not retried per-session", async () => {
    const sessions = [makeSession("solo")];
    const preparePayloads = vi.fn<AgentSessionPayloadPreparer>(() =>
      Promise.reject(new Error("worker timed out"))
    );

    const result = await prepareCandidatePayloadsIsolated(
      preparePayloads,
      sessions,
      MAX_BYTES
    );

    assert.deepEqual(
      result.failures.map((f) => f.session.externalSessionId),
      ["solo"]
    );
    assert.strictEqual(
      preparePayloads.mock.calls.length,
      1,
      "no redundant retry for a lone candidate — the batch failure IS its failure"
    );
  });
});

describe("handlePreparationFailures", () => {
  test("charges each failing session by its own error and emits Failure below threshold", () => {
    const charged: string[] = [];
    const emitted: unknown[] = [];
    handlePreparationFailures(
      {
        chargeTransportError: (sessionId) => {
          charged.push(sessionId);
          return false; // sub-threshold: not yet dead-lettered
        },
        emitBatchTelemetry: (event) => emitted.push(event),
      },
      [
        { session: makeSession("x"), error: new Error("boom-x") },
        { session: makeSession("y"), error: new Error("boom-y") },
      ],
      Date.now()
    );

    assert.deepEqual(
      charged,
      ["x", "y"],
      "every failing session is charged once"
    );
    assert.strictEqual(emitted.length, 1, "exactly one batch telemetry event");
    const [event] = emitted as {
      outcome: unknown;
      payloadBytes: number;
      reason: unknown;
      latencyMs: number;
    }[];
    assert.strictEqual(event.outcome, DesktopSyncBatchOutcome.Failure);
    assert.strictEqual(event.payloadBytes, 0);
    assert.strictEqual(event.reason, SyncReason.TransportError);
    assert.ok(event.latencyMs >= 0, "latency is clamped non-negative");
  });

  test("emits DeadLetter when any charged session crosses the budget", () => {
    const emitted: { outcome: unknown }[] = [];
    handlePreparationFailures(
      {
        chargeTransportError: (sessionId) => sessionId === "dead",
        emitBatchTelemetry: (event) => emitted.push(event),
      },
      [
        { session: makeSession("alive"), error: new Error("t") },
        { session: makeSession("dead"), error: new Error("t") },
      ],
      Date.now()
    );

    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].outcome, DesktopSyncBatchOutcome.DeadLetter);
  });
});
