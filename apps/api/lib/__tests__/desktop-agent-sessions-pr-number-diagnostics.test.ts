import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  PR_INT_MAX,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_AGENT_SESSIONS_OVERSIZED_PR_REFS_DROPPED_EVENT,
  handleDesktopAgentSessionsEvent,
} from "../desktop-agent-sessions-handler";
import {
  desktopAgentSessionsHandlerContext as baseContext,
  upsertBatchMock,
  validDesktopAgentSessionsPayload as validPayload,
} from "./desktop-agent-sessions-handler-fixtures";

const { mockEmitTelemetryMetric, mockLog } = vi.hoisted(() => ({
  mockEmitTelemetryMetric: vi.fn(),
  mockLog: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: mockLog,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mockEmitTelemetryMetric,
}));

beforeEach(() => {
  mockEmitTelemetryMetric.mockReset();
  mockLog.debug.mockReset();
  mockLog.error.mockReset();
  mockLog.info.mockReset();
  mockLog.warn.mockReset();
});

describe("handleDesktopAgentSessionsEvent — oversized PR ref diagnostics", () => {
  it("reports dropped oversized refs while accepting the degraded payload", async () => {
    const upsertBatch = upsertBatchMock(["sess-1"]);
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [pullRequestArtifactRef(PR_INT_MAX + 1)],
          prRefs: [sessionPrRef(PR_INT_MAX + 2)],
        },
      ],
    };

    await expect(
      handleDesktopAgentSessionsEvent(payload, baseContext, {
        upsertBatch,
      })
    ).resolves.toEqual({ accepted: true });

    const parsedPayload = upsertBatch.mock.calls[0]?.[1];
    expect(parsedPayload?.sessions[0].artifactRefs).toBeUndefined();
    expect(parsedPayload?.sessions[0].prRefs).toBeUndefined();
    expect(mockLog.warn).toHaveBeenCalledWith(
      DESKTOP_AGENT_SESSIONS_OVERSIZED_PR_REFS_DROPPED_EVENT,
      {
        artifactRefCount: 1,
        computeTargetId: "target-1",
        droppedRefCount: 2,
        maxPrNumber: PR_INT_MAX + 2,
        organizationId: "org-1",
        prRefCount: 1,
        samples: [
          {
            field: "artifactRefs",
            prNumber: PR_INT_MAX + 1,
            repositoryFullName: "closedloop-ai/closedloop-ai",
            sessionExternalId: "sess-1",
          },
          {
            field: "prRefs",
            prNumber: PR_INT_MAX + 2,
            repositoryFullName: "closedloop-ai/closedloop-ai",
            sessionExternalId: "sess-1",
          },
        ],
        sessionCount: 1,
        userId: "user-1",
      }
    );
    expect(mockEmitTelemetryMetric).not.toHaveBeenCalled();
  });
});

function pullRequestArtifactRef(prNumber: number) {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    method: ArtifactRefMethod.HarnessPrLink,
    prNumber,
    relation: ArtifactRefRelation.Referenced,
    repositoryFullName: "closedloop-ai/closedloop-ai",
  };
}

function sessionPrRef(prNumber: number) {
  return {
    prNumber,
    prUrl: `https://github.com/closedloop-ai/closedloop-ai/pull/${prNumber}`,
    relationType: SessionPrRelationType.Referenced,
    repositoryFullName: "closedloop-ai/closedloop-ai",
  };
}
