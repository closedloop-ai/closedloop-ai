import {
  AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
  AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  AgentComponentInvocationSyncAckState,
  AgentComponentInvocationSyncRejectReason,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";
import { item } from "@repo/api/src/types/agent-component-invocation-schema.test-helpers";
import { DesktopAgentComponentInvocationSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { PG_TIMESTAMP_MIN_MS } from "@repo/api/src/types/pg-timestamp-floor";
import {
  NUL_CHARACTER,
  PostgresTextRejection,
} from "@repo/api/src/types/postgres-text";
import { Result } from "@repo/api/src/types/result";
import { log } from "@repo/observability/log";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    authMethod: "desktop_session",
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
    expect(mocks.sync).toHaveBeenCalledWith(
      {
        // ISS-11426: the credential kind reaches the ownership-refusal telemetry.
        authMethod: "desktop_session",
        clerkUserId: "clerk-user-1",
        computeTargetId: "target-1",
        organizationId: "org-1",
        part: payload.parts[0],
        userId: "user-1",
      },
      // ISS-12552: a session caller records nothing, so no record callback.
      undefined
    );
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
    // Every member of AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS
    // must reach the service: v1 telemetry-free, v2 telemetry with NO label, v3
    // telemetry plus its label, v4 `succeeded`, v5 a findings funnel. v2 is the one
    // that matters
    // for skew — an already-installed Desktop that predates ISS-7795 emits
    // exactly that, and a 400 there is classed PERMANENT and dead-letters the
    // for skew — an already-installed Desktop that predates ISS-7795 emits
    // exactly that, and a 400 there is classed PERMANENT and dead-letters the
    // generation. v5 proves a findings part clears `hasUnsupportedProtocolVersion`
    // and reaches the service with both counts intact (ISS-10725 review).
    const v1 = await POST(request(batch()), routeContext());
    const v2 = await POST(request(telemetryBatch()), routeContext());
    const v3 = await POST(request(measurementBatch()), routeContext());
    const v5 = await POST(request(findingsBatch()), routeContext());

    expect(v1.status).toBe(200);
    expect(v2.status).toBe(200);
    expect(v3.status).toBe(200);
    expect(v5.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledTimes(4);
    expect(mocks.sync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        part: expect.objectContaining({
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        }),
      }),
      undefined
    );
    expect(mocks.sync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        part: expect.objectContaining({
          protocolVersion:
            AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
        }),
      }),
      undefined
    );
    expect(mocks.sync).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        part: expect.objectContaining({
          protocolVersion:
            AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
        }),
      }),
      undefined
    );
    expect(mocks.sync).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        part: expect.objectContaining({
          protocolVersion:
            AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION,
        }),
      }),
      undefined
    );
  });

  it("forwards a v10 tool-result verdict to the service intact", async () => {
    const [part] = batch().parts;
    const toolVerdict = {
      externalInvocationId: "invocation-1",
      sourceSessionId: "session-1",
      kind: AgentComponentInvocationKind.Tool,
      componentKey: "Bash",
      relationship: AgentComponentInvocationRelationship.Direct,
      invokedAt: "2026-07-22T16:00:00.000Z",
      sequence: 0,
      anchor: {
        kind: AgentComponentInvocationAnchorKind.Event,
        eventId: "event-1",
      },
      status: AgentComponentInvocationAttributionStatus.Unresolved,
      evidenceClass: AgentComponentInvocationEvidenceClass.None,
      succeeded: false,
    };
    const response = await POST(
      request({
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION,
        parts: [
          {
            ...part,
            protocolVersion:
              AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION,
            items: [toolVerdict],
          },
        ],
      }),
      routeContext()
    );

    expect(response.status).toBe(200);
    const [{ part: forwarded }] = mocks.sync.mock.calls[0];
    expect(forwarded.items[0].kind).toBe(AgentComponentInvocationKind.Tool);
    expect(forwarded.items[0].succeeded).toBe(false);
  });

  it("forwards a v5 findings item to the service with both counts intact", async () => {
    // The route must carry the pair through unchanged: dropping or coercing one
    // half would land a half-set pair the service then refuses, and a measured
    // zero must survive as a zero rather than being read as absent.
    await POST(request(findingsBatch()), routeContext());

    const [{ part }] = mocks.sync.mock.calls[0];
    expect(part.items[0].findingsEmitted).toBe(6);
    expect(part.items[0].findingsInvalidated).toBe(0);
  });

  it("forwards a v2 telemetry item to the service with no label invented", async () => {
    // The absent label must stay ABSENT through the boundary. Serializing it as
    // `null` would change the bytes the API hashes, so the generation hash the
    // producer signed could never reconcile.
    await POST(request(telemetryBatch()), routeContext());

    const [{ part }] = mocks.sync.mock.calls[0];
    expect(Object.hasOwn(part.items[0], "usageMeasurement")).toBe(false);
    expect(part.items[0].footprintTokens).toBe(4096);
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

  it("ISS-11426: names an unowned target on the 403 body", async () => {
    mocks.sync.mockResolvedValueOnce(
      Result.err(
        DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
      )
    );

    const response = await POST(request(batch()), routeContext());

    expect(response.status).toBe(403);
    // The STATUS is unchanged on purpose (every installed client reads it), so
    // the body is the only thing that can carry the distinction — asserting the
    // status alone is what let the two denials be indistinguishable.
    await expect(response.json()).resolves.toMatchObject({
      code: DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned,
    });
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

  // ISS-8688: this lane reads its body through the shared desktop write-lane
  // `readBoundedJsonBody`, not `parseBody`, so it needs the same
  // read-failure/malformed split. It is also one of the highest-volume body
  // writes we have and one that gets cut off under pool pressure, which is the
  // incident shape the ticket came out of.
  it("returns a 500 for a body short of its Content-Length", async () => {
    const partial = Buffer.from('{"protocolVersion":1,"parts":[');
    const response = await POST(
      new NextRequest(
        "https://api.example.test/desktop/agent-sessions/invocations/sync?computeTargetId=target-1",
        {
          duplex: "half",
          body: shortStream(new Uint8Array(partial)),
          method: "POST",
          headers: { "Content-Length": String(partial.byteLength + 8) },
        } as ConstructorParameters<typeof NextRequest>[1]
      ),
      routeContext()
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Failed to read request body",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("returns a 500 when the request stream errors mid-read", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/desktop/agent-sessions/invocations/sync?computeTargetId=target-1",
        {
          duplex: "half",
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("stream aborted"));
            },
          }),
          method: "POST",
        } as ConstructorParameters<typeof NextRequest>[1]
      ),
      routeContext()
    );

    expect(response.status).toBe(500);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  // The complement: a complete body still answers 400, so the truncation
  // predicate above cannot be passing by always firing.
  it("still returns a 400 for a complete malformed body", async () => {
    const bytes = Buffer.from("not valid json");
    const response = await POST(
      new NextRequest(
        "https://api.example.test/desktop/agent-sessions/invocations/sync?computeTargetId=target-1",
        {
          duplex: "half",
          body: shortStream(new Uint8Array(bytes)),
          method: "POST",
          headers: { "Content-Length": String(bytes.byteLength) },
        } as ConstructorParameters<typeof NextRequest>[1]
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Invalid JSON body",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  // ISS-9174: a value Postgres refuses is rejected HERE, before the service and
  // therefore before `withDb.tx`. Today's alternative was a throw inside the
  // transaction that the desktop classed as transient and retried forever.
  it.each([
    [
      "a NUL in an item string",
      () => {
        const [basePart] = batch().parts;
        return {
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          parts: [
            {
              ...basePart,
              items: [
                {
                  ...item("invocation-1"),
                  componentKey: `revie${NUL_CHARACTER}wer`,
                },
              ],
            },
          ],
        };
      },
    ],
    [
      "a below-floor item invokedAt",
      () => {
        const [basePart] = batch().parts;
        return {
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          parts: [
            {
              ...basePart,
              items: [
                {
                  ...item("invocation-1"),
                  invokedAt: new Date(PG_TIMESTAMP_MIN_MS - 1).toISOString(),
                },
              ],
            },
          ],
        };
      },
    ],
    [
      "a below-floor part sourceUpdatedAt",
      () => {
        const payload = batch();
        payload.parts[0].sourceUpdatedAt = new Date(
          PG_TIMESTAMP_MIN_MS - 1
        ).toISOString();
        return payload;
      },
    ],
  ])(
    "rejects %s with a 400 and never reaches the service",
    async (_label, payload) => {
      const response = await POST(request(payload()), routeContext());

      expect(response.status).toBe(400);
      expect(mocks.sync).not.toHaveBeenCalled();
    }
  );

  // The 400 is the server's ONLY record of the part for an older desktop or an
  // `sk_live_*` producer, because `badRequestResponse` does not log. Before
  // ISS-9174 these values reached `ingestPartInTx` and were logged there; the
  // log line IS the contract this replacement owes, so it is asserted.
  describe("validation-failure logging", () => {
    beforeEach(() => {
      vi.spyOn(log, "error").mockImplementation(() => {
        // Silence the line under assertion; the spy is the assertion target.
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("logs the rejected part's identifiers and issue paths at the 400", async () => {
      const response = await POST(request(nulRawNamePayload()), routeContext());

      expect(response.status).toBe(400);
      expect(mocks.sync).not.toHaveBeenCalled();
      const logError = vi.mocked(log.error);
      expect(logError).toHaveBeenCalledTimes(1);
      const [message, context] = logError.mock.calls[0];
      expect(message).toBe("Agent component invocation sync payload rejected");
      expect(context).toMatchObject({
        computeTargetId: "target-1",
        externalGenerationId: "a".repeat(64),
        externalSessionId: "session-1",
        issues: expect.arrayContaining([
          expect.objectContaining({
            message: PostgresTextRejection.ContainsNul,
            path: "parts.0.items.0.rawName",
          }),
        ]),
        organizationId: "org-1",
        partIndex: 0,
      });
    });

    it("keeps the rejected value itself out of the log line", async () => {
      await POST(request(nulRawNamePayload()), routeContext());

      const [, context] = vi.mocked(log.error).mock.calls[0];
      expect(JSON.stringify(context)).not.toContain(NUL_CHARACTER);
    });
  });
});

function nulRawNamePayload() {
  const [basePart] = batch().parts;
  return {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    parts: [
      {
        ...basePart,
        items: [
          { ...item("invocation-1"), rawName: `code-rev${NUL_CHARACTER}iewer` },
        ],
      },
    ],
  };
}

function shortStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

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

function measurementBatch() {
  // Built by construction rather than by mutating `batch()`: the telemetry
  // version is a DIFFERENT member of the protocol-version union, so assigning it
  // over the telemetry-free literal is a type error, and widening the fixture
  // with a cast would hide exactly the drift this union is there to catch.
  const [telemetryFreePart] = batch().parts;
  return {
    protocolVersion:
      AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
    parts: [
      {
        ...telemetryFreePart,
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
        items: [telemetryItem()],
      },
    ],
  };
}

/**
 * ISS-10725: a part carrying the findings funnel, which moves the declared
 * version to v5. Built by construction for the same reason `measurementBatch`
 * is — the version is a different member of the union, so a cast would hide the
 * drift the union exists to catch.
 */
function findingsBatch() {
  const [telemetryFreePart] = batch().parts;
  return {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION,
    parts: [
      {
        ...telemetryFreePart,
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION,
        items: [findingsItem()],
      },
    ],
  };
}

function findingsItem() {
  return {
    ...telemetryItem(),
    findingsEmitted: 6,
    findingsInvalidated: 0,
  };
}

/**
 * ISS-7795 (codex P1 review): the v2 wire shape an already-installed Desktop
 * still emits — telemetry with no measurement label. Built as the BASE that
 * `telemetryItem` labels, so the two fixtures cannot drift apart and the v2
 * case stays a real subset of the v3 one.
 */
function telemetryBatch() {
  const [telemetryFreePart] = batch().parts;
  return {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
    parts: [
      {
        ...telemetryFreePart,
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
        items: [unlabelledTelemetryItem()],
      },
    ],
  };
}

function telemetryItem() {
  return {
    ...unlabelledTelemetryItem(),
    usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
  };
}

function unlabelledTelemetryItem() {
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
