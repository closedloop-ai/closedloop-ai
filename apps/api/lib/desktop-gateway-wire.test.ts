/**
 * Coverage for the Desktop gateway wire helpers.
 *
 * `toWireCommandFromRelayOperation` is the boundary that turns a browser-supplied
 * relay operation into a command Electron will execute, so its rejections are
 * load-bearing: a non-`/api/gateway/` path must never become a wire command, and
 * the semantic `operationId` Electron dispatches on is resolved from the trusted
 * PATH, not from the caller-supplied id (the browser sends a random UUID).
 */

import { describe, expect, it } from "vitest";
import {
  isTerminalEventData,
  normalizeMethod,
  parseCommandAckPayload,
  parseCommandEventPayload,
  resolveOperationId,
  splitPathAndQuery,
  toStringRecord,
  toWireCommandFromRelayOperation,
  toWireCommandFromStore,
} from "./desktop-gateway-wire";

const LAUNCH = "/api/gateway/symphony/launch";

function relayOperation(
  params: Record<string, unknown>,
  overrides: { operationId?: string; streaming?: boolean } = {}
) {
  return {
    operationId:
      overrides.operationId ?? "b1f0c0de-0000-4000-8000-000000000000",
    params: params as Parameters<
      typeof toWireCommandFromRelayOperation
    >[0]["params"],
    ...(overrides.streaming === undefined
      ? {}
      : { streaming: overrides.streaming }),
  };
}

const request = (over: Record<string, unknown> = {}) => ({
  path: LAUNCH,
  method: "POST",
  ...over,
});

describe("isTerminalEventData", () => {
  it("is true only for a record whose terminal is exactly true", () => {
    expect(isTerminalEventData({ terminal: true })).toBe(true);
    expect(isTerminalEventData({ terminal: "true" })).toBe(false);
    expect(isTerminalEventData({ terminal: false })).toBe(false);
    expect(isTerminalEventData({})).toBe(false);
    expect(isTerminalEventData(null)).toBe(false);
    expect(isTerminalEventData("terminal")).toBe(false);
  });
});

describe("normalizeMethod / toStringRecord", () => {
  it("accepts a supported method and rejects anything else", () => {
    expect(normalizeMethod("POST")).toBe("POST");
    expect(normalizeMethod("get")).toBeNull();
    expect(normalizeMethod(42)).toBeNull();
    expect(normalizeMethod(undefined)).toBeNull();
  });

  it("accepts a flat string record and rejects a non-string value", () => {
    expect(toStringRecord({ a: "1" })).toEqual({ a: "1" });
    expect(toStringRecord({ a: 1 })).toBeUndefined();
    expect(toStringRecord("nope")).toBeUndefined();
    expect(toStringRecord(undefined)).toBeUndefined();
  });
});

describe("splitPathAndQuery", () => {
  it("omits query entirely when there is none", () => {
    expect(splitPathAndQuery(LAUNCH)).toEqual({ path: LAUNCH });
  });

  it("returns a single-valued param as a string", () => {
    expect(splitPathAndQuery(`${LAUNCH}?a=1`)).toEqual({
      path: LAUNCH,
      query: { a: "1" },
    });
  });

  it("groups a repeated param into an array rather than keeping the last", () => {
    // Dropping repeats would silently lose a filter dimension.
    expect(splitPathAndQuery(`${LAUNCH}?id=a&id=b&other=c`)).toEqual({
      path: LAUNCH,
      query: { id: ["a", "b"], other: "c" },
    });
  });
});

describe("resolveOperationId", () => {
  it("resolves an exact path", () => {
    expect(resolveOperationId(LAUNCH)).toBe("symphony_launch");
    expect(resolveOperationId("/api/gateway/health-check")).toBe(
      "health_check"
    );
  });

  it("resolves a prefix path", () => {
    expect(resolveOperationId("/api/gateway/symphony/logs/abc123")).toBe(
      "symphony_logs"
    );
  });

  it("prefers the exact match over a prefix that also matches", () => {
    // `/symphony/status` is exact; `/symphony/status/` is a prefix entry.
    expect(resolveOperationId("/api/gateway/symphony/status")).toBe(
      "symphony_status"
    );
  });

  it("returns null for a gateway path with no mapping", () => {
    expect(resolveOperationId("/api/gateway/unmapped-thing")).toBeNull();
  });

  it("returns null for a path outside the gateway namespace", () => {
    expect(resolveOperationId("/api/documents/1")).toBeNull();
    expect(resolveOperationId("/symphony/launch")).toBeNull();
  });
});

describe("parseCommandAckPayload / parseCommandEventPayload", () => {
  it("rejects a malformed ack", () => {
    expect(parseCommandAckPayload({ nope: true })).toBeNull();
    expect(parseCommandAckPayload(null)).toBeNull();
  });

  it("normalizes an absent event data to null rather than leaving it undefined", () => {
    const parsed = parseCommandEventPayload({
      commandId: "c1",
      sequence: 1,
      eventType: "chunk",
    });

    expect(parsed).toMatchObject({ commandId: "c1", sequence: 1 });
    expect(parsed?.data).toBeNull();
  });

  it("rejects a non-positive sequence", () => {
    expect(
      parseCommandEventPayload({
        commandId: "c1",
        sequence: 0,
        eventType: "chunk",
      })
    ).toBeNull();
  });
});

describe("toWireCommandFromStore", () => {
  const base = {
    commandId: "c1",
    operationId: "stored-uuid",
    method: "POST" as const,
    path: LAUNCH,
    createdAt: "2026-08-07T00:00:00.000Z",
  };

  it("overrides the stored operationId with the one resolved from the path", () => {
    expect(toWireCommandFromStore(base).operationId).toBe("symphony_launch");
  });

  it("falls back to the stored operationId when the path resolves to nothing", () => {
    expect(
      toWireCommandFromStore({ ...base, path: "/api/gateway/unmapped" })
        .operationId
    ).toBe("stored-uuid");
  });

  it("carries createdAt through as queuedAt", () => {
    expect(toWireCommandFromStore(base).queuedAt).toBe(base.createdAt);
  });

  it("emits streaming only when it is exactly true", () => {
    expect(toWireCommandFromStore({ ...base, streaming: true }).streaming).toBe(
      true
    );
    expect(
      toWireCommandFromStore({ ...base, streaming: false }).streaming
    ).toBeUndefined();
    expect(toWireCommandFromStore(base).streaming).toBeUndefined();
  });
});

describe("toWireCommandFromRelayOperation — rejections", () => {
  it("rejects a missing path, an unsupported method, or a missing commandId", () => {
    expect(
      toWireCommandFromRelayOperation(
        relayOperation({ commandId: "c1", request: request({ path: 42 }) })
      )
    ).toBeNull();
    expect(
      toWireCommandFromRelayOperation(
        relayOperation({
          commandId: "c1",
          request: request({ method: "TRACE" }),
        })
      )
    ).toBeNull();
    expect(
      toWireCommandFromRelayOperation(relayOperation({ request: request() }))
    ).toBeNull();
  });

  it("rejects a path outside the /api/gateway namespace", () => {
    // The gateway boundary: a browser-supplied path must not become a command
    // for anything else.
    expect(
      toWireCommandFromRelayOperation(
        relayOperation({
          commandId: "c1",
          request: request({ path: "/api/documents/1" }),
        })
      )
    ).toBeNull();
  });

  it("rejects a traversal that escapes the namespace once normalized", () => {
    // splitPathAndQuery runs the path through URL, which resolves `..` — so the
    // namespace check sees the RESOLVED path, not the raw one.
    expect(
      toWireCommandFromRelayOperation(
        relayOperation({
          commandId: "c1",
          request: request({ path: "/api/gateway/../documents/1" }),
        })
      )
    ).toBeNull();
  });

  it("rejects params that are not an object at all", () => {
    expect(
      toWireCommandFromRelayOperation(relayOperation("not-an-object" as never))
    ).toBeNull();
  });
});

describe("toWireCommandFromRelayOperation — mapping", () => {
  it("resolves the semantic operationId from the path, not the supplied uuid", () => {
    const wire = toWireCommandFromRelayOperation(
      relayOperation({ commandId: "c1", request: request() })
    );

    expect(wire?.operationId).toBe("symphony_launch");
    expect(wire?.commandId).toBe("c1");
  });

  it("falls back to the supplied operationId for an unmapped gateway path", () => {
    const wire = toWireCommandFromRelayOperation(
      relayOperation(
        {
          commandId: "c1",
          request: request({ path: "/api/gateway/unmapped" }),
        },
        { operationId: "caller-id" }
      )
    );

    expect(wire?.operationId).toBe("caller-id");
  });

  it("splits query off the path", () => {
    const wire = toWireCommandFromRelayOperation(
      relayOperation({
        commandId: "c1",
        request: request({ path: `${LAUNCH}?tag=a&tag=b` }),
      })
    );

    expect(wire?.path).toBe(LAUNCH);
    expect(wire?.query).toEqual({ tag: ["a", "b"] });
  });

  it("defaults an absent body to null rather than undefined", () => {
    const wire = toWireCommandFromRelayOperation(
      relayOperation({ commandId: "c1", request: request() })
    );

    expect(wire?.body).toBeNull();
  });

  it("drops optional params whose type is wrong instead of forwarding them", () => {
    const wire = toWireCommandFromRelayOperation(
      relayOperation({
        commandId: "c1",
        request: request(),
        timeoutMs: "soon",
        lockKey: 7,
        requiresApproval: "yes",
        approvalReason: 42,
        signature: 1,
        signaturePayload: {},
        publicKeyFingerprint: [],
      })
    );

    expect(wire?.timeoutMs).toBeUndefined();
    expect(wire?.lockKey).toBeUndefined();
    expect(wire?.requiresApproval).toBeUndefined();
    expect(wire?.approvalReason).toBeUndefined();
    expect(wire?.signature).toBeUndefined();
    expect(wire?.signaturePayload).toBeUndefined();
    expect(wire?.publicKeyFingerprint).toBeUndefined();
  });

  it("forwards well-typed optional params, including the signature triple", () => {
    const wire = toWireCommandFromRelayOperation(
      relayOperation({
        commandId: "c1",
        request: request({ headers: { "x-a": "1" } }),
        timeoutMs: 5000,
        lockKey: "repo:acme/web",
        requiresApproval: true,
        approvalReason: "destructive",
        signature: "sig",
        signaturePayload: "payload",
        publicKeyFingerprint: "fp",
      })
    );

    expect(wire).toMatchObject({
      timeoutMs: 5000,
      lockKey: "repo:acme/web",
      requiresApproval: true,
      approvalReason: "destructive",
      signature: "sig",
      signaturePayload: "payload",
      publicKeyFingerprint: "fp",
      headers: { "x-a": "1" },
    });
  });

  it("emits streaming only when the operation says exactly true", () => {
    const withStreaming = toWireCommandFromRelayOperation(
      relayOperation(
        { commandId: "c1", request: request() },
        { streaming: true }
      )
    );
    const withoutStreaming = toWireCommandFromRelayOperation(
      relayOperation(
        { commandId: "c1", request: request() },
        { streaming: false }
      )
    );

    expect(withStreaming?.streaming).toBe(true);
    expect(withoutStreaming?.streaming).toBeUndefined();
  });
});
