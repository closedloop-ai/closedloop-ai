import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { createDesktopAgentComponentInvocationsClient } from "../src/main/dashboard/desktop-agent-component-invocations-client.js";

describe("desktop agent component invocations client", () => {
  it("posts one exact part to the dedicated authenticated endpoint", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
      [];
    const fetchMock: typeof fetch = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(
        Response.json({
          success: true,
          data: {
            accepted: true,
            protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
            externalGenerationId: "a".repeat(64),
            partIndex: 0,
            partHash: "b".repeat(64),
            state: AgentComponentInvocationSyncAckState.Activated,
          },
        })
      );
    };
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: fetchMock,
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
    });

    const result = await client.syncPart(part());

    assert.equal(result.kind, "ack");
    assert.equal(
      String(calls[0].input),
      "https://api.example.test/desktop/agent-sessions/invocations/sync?computeTargetId=target-1"
    );
    assert.equal(
      new Headers(calls[0].init?.headers).get("Authorization"),
      "Bearer session-token"
    );
  });

  it("treats an old API endpoint as unavailable and retains retry ownership", async () => {
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
      getAccessToken: async () => null,
      getApiKey: () => "sk_live_test",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
    });

    assert.deepEqual(await client.syncPart(part()), {
      kind: "unavailable",
      status: 404,
    });
  });

  it("retains an unsupported protocol response as capability-unavailable", async () => {
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () => Promise.resolve(new Response(null, { status: 501 })),
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
    });

    assert.deepEqual(await client.syncPart(part()), {
      kind: "unavailable",
      status: 501,
    });
  });

  it("maps permanent HTTP validation failures to an exact rejected ack", async () => {
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () => Promise.resolve(new Response(null, { status: 413 })),
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "wrong-target",
    });
    const pending = part();

    const result = await client.syncPart(pending, "bound-target");

    assert.deepEqual(result, {
      kind: "ack",
      ack: {
        accepted: false,
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        externalGenerationId: pending.externalGenerationId,
        partIndex: pending.partIndex,
        partHash: pending.partHash,
        reason: AgentComponentInvocationSyncRejectReason.ValidationFailed,
      },
    });
  });

  // ISS-5789: THIS is the live cross-repo boundary for a rejection reason. A cloud
  // newer than this desktop build can name a reason this build has never heard of,
  // and `isRejectReason` is what keeps it from reaching the budget classifier. The
  // required degradation is a plain retry: an unrecognized rejection is not one we
  // can attribute to this part, so it must never become a dead-letter — this lane
  // has no dead-letter recovery, so mis-classifying here loses the data outright.
  it("ISS-5789: degrades a rejection reason this build does not know to a retry", async () => {
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () =>
        Promise.resolve(
          Response.json({
            success: true,
            data: {
              accepted: false,
              protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
              externalGenerationId: "a".repeat(64),
              partIndex: 0,
              partHash: "c".repeat(64),
              reason: "reason_added_after_this_build",
            },
          })
        ),
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
    });

    const result = await client.syncPart(part(), "target-1");

    assert.deepEqual(result, {
      kind: "retry",
      error: "invocation sync returned an invalid ack",
    });
  });
});

/**
 * ISS-4976 (@wongk T5 / @closedloop-ai-stage T1): a telemetry-carrying part
 * declares v2, so an API that predates telemetry answers its EXISTING version
 * gate (501 `protocol_unsupported`) rather than a 400 the client would class as
 * a permanent `validation_failed` and dead-letter after five attempts.
 */
describe("telemetry protocol version skew", () => {
  it("declares the part's own version on the envelope", async () => {
    const bodies: string[] = [];
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: (_input, init) => {
        bodies.push(String(init?.body));
        return Promise.resolve(new Response(null, { status: 501 }));
      },
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
    });

    await client.syncPart(part());
    await client.syncPart(telemetryPart());

    assert.equal(
      JSON.parse(bodies[0] ?? "{}").protocolVersion,
      AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION
    );
    assert.equal(
      JSON.parse(bodies[1] ?? "{}").protocolVersion,
      AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION
    );
  });

  it("treats an older API's version rejection as retryable, never a dead-letter", async () => {
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () => Promise.resolve(new Response(null, { status: 501 })),
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
    });

    const result = await client.syncPart(telemetryPart());

    // `unavailable` is held and retried; only an `ack` with a permanent reason
    // ever reaches the dead-letter path.
    assert.equal(result.kind, "unavailable");
    assert.equal(result.status, 501);
  });

  it("accepts an ack echoing the telemetry version it sent", async () => {
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () =>
        Promise.resolve(
          Response.json({
            success: true,
            data: {
              accepted: true,
              protocolVersion:
                AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
              externalGenerationId: "a".repeat(64),
              partIndex: 0,
              partHash: "b".repeat(64),
              state: AgentComponentInvocationSyncAckState.Activated,
            },
          })
        ),
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
    });

    const result = await client.syncPart(telemetryPart());

    assert.equal(result.kind, "ack");
    assert.equal(
      result.kind === "ack" ? result.ack.protocolVersion : null,
      AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION
    );
  });

  it("rejects an ack echoing a version it did not send", async () => {
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () =>
        Promise.resolve(
          Response.json({
            success: true,
            data: {
              accepted: true,
              protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
              externalGenerationId: "a".repeat(64),
              partIndex: 0,
              partHash: "b".repeat(64),
              state: AgentComponentInvocationSyncAckState.Activated,
            },
          })
        ),
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
    });

    const result = await client.syncPart(telemetryPart());

    assert.equal(result.kind, "retry");
  });
});

function telemetryPart(): AgentComponentInvocationSyncPart {
  return {
    ...part(),
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  };
}

function part(): AgentComponentInvocationSyncPart {
  return {
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
  };
}
