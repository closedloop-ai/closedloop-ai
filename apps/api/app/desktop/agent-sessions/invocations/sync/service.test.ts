import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { DesktopAgentComponentInvocationSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { Result } from "@repo/api/src/types/result";
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

  // ISS-11449: target ownership is now the ONLY refusal this service returns;
  // the org session-sync policy denial (ISS-11426's `FeatureDisabled`) is gone.
  it("returns target_not_owned without ingesting for an unowned target", async () => {
    mocks.findOwnedById.mockResolvedValueOnce(null);

    const result = await desktopAgentComponentInvocationsSyncService.sync(
      input()
    );

    expect(result).toEqual(
      Result.err(
        DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
      )
    );
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
