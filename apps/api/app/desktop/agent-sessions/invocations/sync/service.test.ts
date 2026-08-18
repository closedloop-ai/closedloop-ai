import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOwnedById: vi.fn(),
  ingestPart: vi.fn(),
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: mocks.findOwnedById },
}));

vi.mock("@/app/agent-sessions/service/component-invocations", () => ({
  agentComponentInvocationsService: { ingestPart: mocks.ingestPart },
}));

import { desktopAgentComponentInvocationsSyncService } from "./service";

describe("desktopAgentComponentInvocationsSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOwnedById.mockResolvedValue({ id: "target-1" });
    mocks.ingestPart.mockResolvedValue(
      Result.ok({ state: AgentComponentInvocationSyncAckState.Activated })
    );
  });

  it("returns the exact accepted part acknowledgement", async () => {
    const result = await desktopAgentComponentInvocationsSyncService.sync(
      input()
    );

    expect(result).toEqual(
      Result.ok({
        accepted: true,
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        externalGenerationId: "a".repeat(64),
        partIndex: 0,
        partHash: "b".repeat(64),
        state: AgentComponentInvocationSyncAckState.Activated,
      })
    );
  });

  it("returns forbidden without ingesting for an unowned target", async () => {
    mocks.findOwnedById.mockResolvedValueOnce(null);

    const result = await desktopAgentComponentInvocationsSyncService.sync(
      input()
    );

    expect(result).toEqual(Result.err(Status.Forbidden));
    expect(mocks.ingestPart).not.toHaveBeenCalled();
  });

  it("FEA-4169: denies (Status.Forbidden) when the org session-sync policy is OFF, without ingesting", async () => {
    const isOrgPolicyEnabled = vi.fn(async () => false);

    const result = await desktopAgentComponentInvocationsSyncService.sync({
      ...input(),
      isOrgPolicyEnabled,
    });

    expect(result).toEqual(Result.err(Status.Forbidden));
    expect(isOrgPolicyEnabled).toHaveBeenCalledWith("org-1");
    expect(mocks.ingestPart).not.toHaveBeenCalled();
  });

  it("returns an exact rejected ack so Desktop retains the outbox part", async () => {
    mocks.ingestPart.mockResolvedValueOnce(
      Result.err(AgentComponentInvocationSyncRejectReason.SessionMissing)
    );

    const result = await desktopAgentComponentInvocationsSyncService.sync(
      input()
    );

    expect(result).toEqual(
      Result.ok({
        accepted: false,
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        externalGenerationId: "a".repeat(64),
        partIndex: 0,
        partHash: "b".repeat(64),
        reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
      })
    );
  });
});

function input() {
  return {
    clerkUserId: "clerk-1",
    computeTargetId: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    // FEA-4169: inject the org-policy gate as allowed so the write-path tests
    // exercise ingest without reaching the real DB-backed lookup. The policy-off
    // denial is covered by its own case above.
    isOrgPolicyEnabled: async () => true,
    part: {
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      externalSessionId: "session-1",
      externalGenerationId: "a".repeat(64),
      sourceUpdatedAt: "2026-07-22T16:00:00.000Z",
      dataRevision: 35,
      sourceSequence: 1,
      partIndex: 0,
      partCount: 1,
      partHash: "b".repeat(64),
      items: [],
    },
  };
}
