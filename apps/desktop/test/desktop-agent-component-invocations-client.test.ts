import assert from "node:assert/strict";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { DesktopAgentComponentInvocationSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { describe, it } from "vitest";
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

  it("treats a bare 404 as an environmental retry and retains retry ownership", async () => {
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
      getAccessToken: async () => null,
      getApiKey: () => "sk_live_test",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
    });

    assert.deepEqual(await client.syncPart(part()), {
      kind: "retry",
      status: 404,
      error: "invocation sync returned HTTP 404",
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

  it("invalidates only the rejected access token on HTTP 401", async () => {
    const rejectedTokens: string[] = [];
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () => Promise.resolve(new Response(null, { status: 401 })),
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
      onUnauthorized: (token) => rejectedTokens.push(token),
    });

    const result = await client.syncPart(part());

    assert.deepEqual(result, {
      kind: "retry",
      status: 401,
      error: "invocation sync returned HTTP 401",
    });
    assert.deepEqual(rejectedTokens, ["session-token"]);
  });

  it("does not invalidate the session token on API-key 401 or HTTP 403", async () => {
    const rejectedTokens: string[] = [];
    const apiKeyClient = createDesktopAgentComponentInvocationsClient({
      fetch: () => Promise.resolve(new Response(null, { status: 401 })),
      getAccessToken: async () => null,
      getApiKey: () => "sk_live_test",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
      onUnauthorized: (token) => rejectedTokens.push(token),
    });
    const forbiddenClient = createDesktopAgentComponentInvocationsClient({
      fetch: () => Promise.resolve(new Response(null, { status: 403 })),
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
      onUnauthorized: (token) => rejectedTokens.push(token),
    });

    assert.equal((await apiKeyClient.syncPart(part())).kind, "retry");
    assert.equal((await forbiddenClient.syncPart(part())).kind, "retry");
    assert.deepEqual(rejectedTokens, []);
  });

  it("carries Retry-After on retryable HTTP failures", async () => {
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () =>
        Promise.resolve(
          new Response(null, {
            status: 429,
            headers: { "Retry-After": "1800" },
          })
        ),
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
    });

    assert.deepEqual(await client.syncPart(part()), {
      kind: "retry",
      status: 429,
      error: "invocation sync returned HTTP 429",
      retryAfterMs: 30 * 60_000,
    });
  });

  it("omits Retry-After when the retryable HTTP header is malformed", async () => {
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () =>
        Promise.resolve(
          new Response(null, {
            status: 503,
            headers: { "Retry-After": "soon" },
          })
        ),
      getAccessToken: async () => "session-token",
      getApiOrigin: () => "https://api.example.test",
      getComputeTargetId: () => "target-1",
    });

    assert.deepEqual(await client.syncPart(part()), {
      kind: "retry",
      status: 503,
      error: "invocation sync returned HTTP 503",
    });
  });

  // ISS-9174: 400 is what the API answers when the shared schema rejects a part
  // (a NUL, a lone surrogate, a below-floor timestamp). The older-desktop
  // remediation claim rests on THIS mapping: 400 must class as the permanent
  // `validation_failed` so the part dead-letters instead of retrying forever.
  for (const status of [400, 413]) {
    it(`maps a permanent HTTP ${status} validation failure to an exact rejected ack`, async () => {
      const client = createDesktopAgentComponentInvocationsClient({
        fetch: () => Promise.resolve(new Response(null, { status })),
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
  }

  // ISS-5789: THIS is the live cross-repo boundary for a rejection reason. A cloud
  // newer than this desktop build can name a reason this build has never heard of,
  // and `isRejectReason` is what keeps it from reaching the budget classifier. The
  // required degradation is a plain retry: an unrecognized rejection is not one we
  // can attribute to this part, so it must never become a permanent dead-letter.
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
 * ISS-4976 (@whitlockk T5 / @closedloop-ai-stage T1): a telemetry-carrying part
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

describe("ISS-11426 coded 403", () => {
  it("carries the server's ownership code onto the retry result", async () => {
    const result = await client(
      Response.json(
        {
          success: false,
          error: "Forbidden",
          code: DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned,
        },
        { status: 403 }
      )
    ).syncPart(part());

    assert.equal(result.kind, "retry");
    assert.equal(
      result.kind === "retry" ? result.forbiddenCode : undefined,
      DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
    );
  });

  it("carries the org-policy code, which the status alone could never say", async () => {
    const result = await client(
      Response.json(
        {
          success: false,
          error: "Forbidden",
          code: DesktopAgentComponentInvocationSyncRestErrorCode.FeatureDisabled,
        },
        { status: 403 }
      )
    ).syncPart(part());

    assert.equal(
      result.kind === "retry" ? result.forbiddenCode : undefined,
      DesktopAgentComponentInvocationSyncRestErrorCode.FeatureDisabled
    );
  });

  it("leaves the code absent for an UNCODED 403 from an older server", async () => {
    // Skew in the other direction: the pre-ISS-11426 API sends a bare 403, and
    // absent must stay absent so the reason fold keeps the status behaviour.
    const result = await client(
      Response.json({ success: false, error: "Forbidden" }, { status: 403 })
    ).syncPart(part());

    assert.equal(result.kind, "retry");
    assert.equal(
      result.kind === "retry" ? result.forbiddenCode : undefined,
      undefined
    );
    assert.equal(
      result.kind === "retry"
        ? Object.hasOwn(result, "forbiddenCode")
        : undefined,
      false
    );
  });

  it("reads an unrecognized code as absent rather than guessing", async () => {
    const result = await client(
      Response.json(
        { success: false, error: "Forbidden", code: "some_future_denial" },
        { status: 403 }
      )
    ).syncPart(part());

    assert.equal(
      result.kind === "retry" ? result.forbiddenCode : undefined,
      undefined
    );
  });

  it("leaves the code absent on a non-403 failure", async () => {
    const result = await client(
      Response.json(
        {
          success: false,
          code: DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned,
        },
        { status: 500 }
      )
    ).syncPart(part());

    assert.equal(
      result.kind === "retry" ? result.forbiddenCode : undefined,
      undefined
    );
  });
});

function client(response: Response) {
  return createDesktopAgentComponentInvocationsClient({
    fetch: () => Promise.resolve(response),
    getAccessToken: async () => "session-token",
    getApiOrigin: () => "https://api.example.test",
    getComputeTargetId: () => "target-1",
  });
}

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
