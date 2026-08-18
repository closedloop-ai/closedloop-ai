import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
  AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  AgentComponentInvocationSyncAckState,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    clerkUserId: "clerk-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  sync: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(mocks.auth, request),
}));

vi.mock("./service", () => ({
  desktopAgentComponentInvocationsSyncService: { sync: mocks.sync },
}));

import { POST } from "./route";

describe("POST /desktop/agent-sessions/invocations/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sync.mockResolvedValue(
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

  it("passes one validated exact part to the owned-target service", async () => {
    const payload = batch();
    const response = await POST(request(payload), routeContext());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: expect.objectContaining({ accepted: true, partIndex: 0 }),
    });
    expect(mocks.sync).toHaveBeenCalledWith({
      clerkUserId: "clerk-user-1",
      computeTargetId: "target-1",
      organizationId: "org-1",
      part: payload.parts[0],
      userId: "user-1",
    });
  });

  it("rejects multi-part request ambiguity before invoking the service", async () => {
    const payload = batch();
    payload.parts.push({ ...payload.parts[0], partIndex: 1 });

    const response = await POST(request(payload), routeContext());

    expect(response.status).toBe(400);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("reports an unsupported protocol as unavailable before strict validation", async () => {
    // ISS-4976: derived from the supported set rather than hardcoded, so this
    // keeps proving the GATE ORDERING (an unknown version must earn the
    // retryable 501, never the 400 the Desktop client classes as a permanent
    // `validation_failed` and dead-letters) whichever versions exist.
    const payload = {
      ...batch(),
      protocolVersion:
        Math.max(
          ...AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS
        ) + 1,
    };

    const response = await POST(request(payload), routeContext());

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      success: false,
      error: "Unsupported component invocation sync protocol",
      code: AgentComponentInvocationSyncRejectReason.ProtocolUnsupported,
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("accepts every supported protocol version at the route", async () => {
    // v1 (telemetry-free) and v2 (telemetry-carrying) must BOTH reach the
    // service. An older Desktop keeps syncing on v1 against this build, and a
    // newer Desktop's telemetry part is not turned away as malformed.
    const telemetryFree = batch();
    const telemetryCarrying = telemetryBatch();

    const v1 = await POST(request(telemetryFree), routeContext());
    const v2 = await POST(request(telemetryCarrying), routeContext());

    expect(v1.status).toBe(200);
    expect(v2.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect(mocks.sync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        part: expect.objectContaining({
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        }),
      })
    );
    expect(mocks.sync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        part: expect.objectContaining({
          protocolVersion:
            AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
        }),
      })
    );
  });

  it("rejects a telemetry item declared under the telemetry-free version", async () => {
    // Keeps v1 honest: an older API's version gate is only a safe skew answer
    // while every v1 part really is telemetry-free.
    const payload = batch();
    payload.parts[0].items.push(telemetryItem());

    const response = await POST(request(payload), routeContext());

    expect(response.status).toBe(400);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("keeps malformed current-v1 payloads as validation failures", async () => {
    const payload = { ...batch(), unexpected: true };

    const response = await POST(request(payload), routeContext());

    expect(response.status).toBe(400);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("maps an unowned target to forbidden", async () => {
    mocks.sync.mockResolvedValueOnce(Result.err(Status.Forbidden));

    const response = await POST(request(batch()), routeContext());

    expect(response.status).toBe(403);
    expect(mocks.sync).toHaveBeenCalledOnce();
  });

  it("rejects oversized bodies before parsing or syncing", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/desktop/agent-sessions/invocations/sync?computeTargetId=target-1",
        {
          body: JSON.stringify({ padding: "x".repeat(1_049_000) }),
          method: "POST",
        }
      ),
      routeContext()
    );

    expect(response.status).toBe(413);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});

function batch() {
  return {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    parts: [
      {
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        externalSessionId: "session-1",
        externalGenerationId: "a".repeat(64),
        sourceUpdatedAt: "2026-07-22T16:00:00.000Z",
        dataRevision: 35,
        sourceSequence: 1,
        partIndex: 0,
        partCount: 1,
        partHash: "b".repeat(64),
        items: [] as ReturnType<typeof telemetryItem>[],
      },
    ],
  };
}

function telemetryBatch() {
  // Built by construction rather than by mutating `batch()`: the telemetry
  // version is a DIFFERENT member of the protocol-version union, so assigning it
  // over the telemetry-free literal is a type error, and widening the fixture
  // with a cast would hide exactly the drift this union is there to catch.
  const [telemetryFreePart] = batch().parts;
  return {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
    parts: [
      {
        ...telemetryFreePart,
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
        items: [telemetryItem()],
      },
    ],
  };
}

function telemetryItem() {
  return {
    externalInvocationId: "invocation-1",
    sourceSessionId: "session-1",
    kind: AgentComponentInvocationKind.Subagent,
    componentKey: "reviewer",
    relationship: AgentComponentInvocationRelationship.ChildSession,
    invokedAt: "2026-07-22T16:00:00.000Z",
    sequence: 0,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: "event-1",
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
    model: "claude-opus-5",
    inputTokens: 1200,
    outputTokens: 340,
    estimatedCost: 0.1255,
    footprintTokens: 4096,
  };
}

function request(body: unknown): NextRequest {
  return new NextRequest(
    "https://api.example.test/desktop/agent-sessions/invocations/sync?computeTargetId=target-1",
    { body: JSON.stringify(body), method: "POST" }
  );
}

function routeContext(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({}) };
}
