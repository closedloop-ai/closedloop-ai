import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import {
  INVOCATION_SYNC_MISSING_PARENTS_CATEGORY,
  InvocationSyncParentStatus,
} from "@repo/api/src/types/invocation-sync-diagnostics";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentComponentInvocationSyncOutboxEntry,
  AgentComponentInvocationSyncService,
  resolveAgentComponentInvocationSyncSource,
} from "../src/main/agent-sync/agent-component-invocation-sync-service.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  buildInvocationSyncMissingParents,
  reportInvocationSyncMissingParents,
} from "../src/main/telemetry/invocation-sync-missing-parents-telemetry.js";
import { Observability } from "../src/main/telemetry/observability.js";
import {
  FakeSource,
  PART_CREATED_AT,
  part,
} from "./helpers/invocation-sync-service-fixtures.js";

afterEach(() => {
  Observability.reset();
  vi.restoreAllMocks();
});

describe("missing-parent diagnostics", () => {
  it("reports every matched missing-parent ack once per tick after recording retries", async () => {
    const first = part();
    const second = { ...part("d".repeat(64)), externalSessionId: "session-2" };
    const source = new FakeSource(first, 2, second);
    const report = vi.fn(
      (entries: AgentComponentInvocationSyncOutboxEntry[]) => {
        expect(source.entries.every((entry) => entry.attemptCount === 3)).toBe(
          true
        );
        expect(entries.map((entry) => entry.part.externalSessionId)).toEqual([
          "session-1",
          "session-2",
        ]);
        return Promise.resolve();
      }
    );
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      now: () => new Date(PART_CREATED_AT),
      onSessionMissingParts: report,
      sendPart: async (pending) => ({
        kind: "ack",
        ack: {
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          accepted: false,
          reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
        },
      }),
    });
    await service.syncOnce();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.any(Array),
      "target-1",
      source,
      expect.any(Function)
    );
  });

  it("hands the reporter the lane's own live send gate", async () => {
    const pending = part();
    const source = new FakeSource(pending);
    let ready = true;
    let gate: (() => boolean) | undefined;
    const service = new AgentComponentInvocationSyncService({
      isReady: () => ready,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      now: () => new Date(PART_CREATED_AT),
      onSessionMissingParts: (_entries, _target, _source, canStillSend) => {
        gate = canStillSend;
        return Promise.resolve();
      },
      sendPart: async () => ({
        kind: "ack",
        ack: {
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          accepted: false,
          reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
        },
      }),
    });
    await service.syncOnce();

    // The reporter must re-read the lane's gate AFTER its own parent read, not a
    // predicate the composition rebuilt: readiness here ANDs the session-metadata
    // consent tier, and a tier change landing during that read has to stop the
    // per-session diagnostic (`main/sync/AGENTS.md` section 12a).
    expect(gate?.()).toBe(true);
    ready = false;
    expect(gate?.()).toBe(false);
  });

  it("reports parents collected before a later part's write threw", async () => {
    const first = part();
    const second = { ...part("d".repeat(64)), externalSessionId: "session-2" };
    const source = new FakeSource(first, 0, second);
    const writeFailure = new Error("retry write failed");
    source.recordInvocationSyncRetry = (
      _sourceKey: string,
      retriedPart: AgentComponentInvocationSyncPart
    ) =>
      retriedPart.externalSessionId === "session-2"
        ? Promise.reject(writeFailure)
        : Promise.resolve();
    const reported: AgentComponentInvocationSyncOutboxEntry[][] = [];
    const report = vi.fn(
      (collected: AgentComponentInvocationSyncOutboxEntry[]) => {
        reported.push(collected);
        return Promise.resolve();
      }
    );
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      now: () => new Date(PART_CREATED_AT),
      onSessionMissingParts: report,
      sendPart: async (pending) => ({
        kind: "ack",
        ack: {
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          accepted: false,
          reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
        },
      }),
    });

    await expect(service.syncOnce()).rejects.toBe(writeFailure);

    // `session-1` was already collected when the second part's retry write threw.
    // An earlier part in the same batch can already be dead-lettered for
    // exhausting its age horizon, so there is no later tick that would report it:
    // dropping the batch's diagnostic on an unrelated part's failure drops it for
    // good.
    expect(report).toHaveBeenCalledTimes(1);
    expect(reported[0]?.map((entry) => entry.part.externalSessionId)).toEqual([
      "session-1",
    ]);
  });

  it("does not misattribute an ack for a different part to this parent", async () => {
    const pending = part();
    const source = new FakeSource(pending);
    const report = vi.fn();
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      now: () => new Date(PART_CREATED_AT),
      onSessionMissingParts: report,
      sendPart: async () => ({
        kind: "ack",
        ack: {
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: 7,
          partHash: pending.partHash,
          accepted: false,
          reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
        },
      }),
    });
    await service.syncOnce();
    expect(report).not.toHaveBeenCalled();
  });

  it("keeps retry state when the diagnostic observer rejects", async () => {
    const pending = part();
    const source = new FakeSource(pending);
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      now: () => new Date(PART_CREATED_AT),
      onSessionMissingParts: () => Promise.reject(new Error("unavailable")),
      sendPart: async () => ({
        kind: "ack",
        ack: {
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          accepted: false,
          reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
        },
      }),
    });
    await expect(service.syncOnce()).resolves.toBeUndefined();
    expect(source.entries[0]?.attemptCount).toBe(1);
    expect(source.deadLetterCalls).toBe(0);
  });

  it("carries the identifiers and local parent state through the authenticated log boundaries", async () => {
    const pending = part();
    const source = new FakeSource(pending);
    const entries = await source.loadReadyInvocationSyncParts(
      "invocations:target-1",
      PART_CREATED_AT
    );
    const parent = {
      externalSessionId: pending.externalSessionId,
      sessionPresent: true,
      outboxStatus: InvocationSyncParentStatus.DeadLettered,
      attemptCount: 5,
      lastError: "ack_omitted",
    };
    const read = vi.fn(async () => [parent]);
    const send = vi.fn();
    Observability.init({
      telemetrySend: send,
      desktopClientVersion: "0.17.367",
    });
    const adapted = resolveAgentComponentInvocationSyncSource(
      Object.assign(source, {
        loadInvocationSyncParents: read,
      }) as unknown as AgentSessionSyncSource
    );
    expect(adapted).not.toBeNull();
    if (!adapted) {
      throw new Error("invocation source was not resolved");
    }
    await reportInvocationSyncMissingParents({
      entries,
      computeTargetId: "target-1",
      sessionSourceKey: "sessions:target-1",
      source: adapted,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const raw = send.mock.calls[0]?.[0];
    const payload = raw;
    expect(payload.category).toBe(INVOCATION_SYNC_MISSING_PARENTS_CATEGORY);
    expect(payload.diagnostics).toEqual({
      invocationSyncMissingParents: {
        computeTargetId: "target-1",
        sessionSourceKey: "sessions:target-1",
        observedAt: expect.any(String),
        parts: [
          {
            externalSessionId: pending.externalSessionId,
            externalGenerationId: pending.externalGenerationId,
            partIndex: pending.partIndex,
            partHash: pending.partHash,
            // Both durable ladders as the row carries them. The former
            // `attemptCount + 1` claimed a count that is on neither row for the
            // rejections that advance only `permanent_attempt_count` — which is
            // every `session_missing` past the retry age horizon, the population
            // this diagnostic exists for.
            attemptCount: 0,
            permanentAttemptCount: 0,
            createdAt: PART_CREATED_AT,
            parent,
          },
        ],
      },
    });
    expect(read).toHaveBeenCalledWith("sessions:target-1", [
      pending.externalSessionId,
    ]);
  });

  it("does not emit when readiness closes during the parent read", async () => {
    const source = new FakeSource(part());
    const entries = await source.loadReadyInvocationSyncParts(
      "target",
      PART_CREATED_AT
    );
    let ready = true;
    const send = vi.fn();
    Observability.init({ telemetrySend: send });
    await reportInvocationSyncMissingParents({
      entries,
      computeTargetId: "target-1",
      sessionSourceKey: "sessions:target-1",
      canReport: () => ready,
      source: Object.assign(source, {
        loadInvocationSyncParents: () => {
          ready = false;
          return Promise.resolve([]);
        },
      }),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("omits unreadable parent facts and marks a failed diagnostic read", async () => {
    const source = new FakeSource(part());
    const entries = await source.loadReadyInvocationSyncParts(
      "target",
      PART_CREATED_AT
    );
    const diagnostic = await buildInvocationSyncMissingParents({
      entries,
      computeTargetId: "target-1",
      sessionSourceKey: "sessions:target-1",
      source: Object.assign(source, {
        loadInvocationSyncParents: () => Promise.reject(new Error("bad read")),
      }),
    });
    expect(diagnostic.parentReadFailed).toBe(true);
    expect(diagnostic.parts[0]).not.toHaveProperty("parent");
  });

  it("works with older sources and flags corrupt timestamps without leaking their value", async () => {
    const source = new FakeSource(part());
    source.createdAt = "private filesystem path";
    const entries = await source.loadReadyInvocationSyncParts(
      "target",
      PART_CREATED_AT
    );
    const diagnostic = await buildInvocationSyncMissingParents({
      entries,
      computeTargetId: "target-1",
      sessionSourceKey: "sessions:target-1",
      source,
    });
    expect(diagnostic.parts[0]?.createdAtInvalid).toBe(true);
    expect(diagnostic.parts[0]).not.toHaveProperty("createdAt");
    expect(diagnostic.parts[0]).not.toHaveProperty("parent");
    expect(diagnostic).not.toHaveProperty("parentReadFailed");
  });
});
