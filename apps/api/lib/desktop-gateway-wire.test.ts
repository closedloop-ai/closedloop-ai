/**
 * Coverage for the Desktop gateway wire helpers.
 *
 * `toWireCommandFromRelayOperation` is the boundary that turns a browser-supplied
 * relay operation into a command Electron will execute, so its rejections are
 * load-bearing: a non-`/api/gateway/` path must never become a wire command, and
 * the semantic `operationId` Electron dispatches on is resolved from the trusted
 * PATH, not from the caller-supplied id (the browser sends a random UUID).
 */

import { log } from "@repo/observability/log";
import type { Socket } from "socket.io";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_REASON_MAX_LENGTH } from "./compute-target-field-limits";
import { PROTOCOL_VERSION } from "./desktop-gateway-types";
import {
  handleRelayOperationForSocket,
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

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const REPOS = "/api/gateway/repos";
// Both throw `TypeError: Invalid URL` from `new URL(..., base)` — the input that
// used to escape the declared `WireCommandPayload | null` contract (ISS-7558).
const MALFORMED_PATHS = ["//[", "http://["];
const TARGET_ID = "target-wire-1";

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
  path: REPOS,
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
    expect(splitPathAndQuery(REPOS)).toEqual({ path: REPOS });
  });

  it("returns a single-valued param as a string", () => {
    expect(splitPathAndQuery(`${REPOS}?a=1`)).toEqual({
      path: REPOS,
      query: { a: "1" },
    });
  });

  it("groups a repeated param into an array rather than keeping the last", () => {
    // Dropping repeats would silently lose a filter dimension.
    expect(splitPathAndQuery(`${REPOS}?id=a&id=b&other=c`)).toEqual({
      path: REPOS,
      query: { id: ["a", "b"], other: "c" },
    });
  });

  it("returns null instead of throwing on a malformed path", () => {
    for (const malformed of MALFORMED_PATHS) {
      expect(() => splitPathAndQuery(malformed)).not.toThrow();
      expect(splitPathAndQuery(malformed)).toBeNull();
    }
  });
});

describe("resolveOperationId", () => {
  it("resolves an exact path", () => {
    expect(resolveOperationId(REPOS)).toBe("repos_config");
    expect(resolveOperationId("/api/gateway/health-check")).toBe(
      "health_check"
    );
  });

  it("resolves a prefix path", () => {
    expect(resolveOperationId("/api/gateway/git/pr/123")).toBe("git_pr");
  });

  it("prefers the exact match over a prefix that also matches", () => {
    // `/git/user` is exact; `/git/` is a prefix entry that also matches it.
    expect(resolveOperationId("/api/gateway/git/user")).toBe("git_pr");
  });

  it("returns null for a gateway path with no mapping", () => {
    expect(resolveOperationId("/api/gateway/unmapped-thing")).toBeNull();
  });

  it("returns null for a path outside the gateway namespace", () => {
    expect(resolveOperationId("/api/documents/1")).toBeNull();
    expect(resolveOperationId("/repos")).toBeNull();
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
    path: REPOS,
    createdAt: "2026-08-07T00:00:00.000Z",
  };

  it("overrides the stored operationId with the one resolved from the path", () => {
    expect(toWireCommandFromStore(base).operationId).toBe("repos_config");
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

  // The three producers bound `approvalReason` on the way in, so only a row
  // written BEFORE them can be malformed — and reconnect replays every stored
  // row through here. Without the sanitizer the desktop's `Headers.set` throws
  // on the value and loses the command on every replay, forever.
  it("drops a legacy stored approvalReason the desktop cannot put in a header", () => {
    expect(
      toWireCommandFromStore({ ...base, approvalReason: "承認が必要です" })
        .approvalReason
    ).toBeUndefined();
    expect(
      toWireCommandFromStore({ ...base, approvalReason: "ok\r\nx-evil: 1" })
        .approvalReason
    ).toBeUndefined();
    expect(
      toWireCommandFromStore({
        ...base,
        approvalReason: "r".repeat(APPROVAL_REASON_MAX_LENGTH + 1),
      }).approvalReason
    ).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "toWireCommandFromStore: malformed stored approvalReason",
      expect.objectContaining({ commandId: base.commandId })
    );
  });

  it("replays a header-safe stored approvalReason byte-identically", () => {
    const atBound = "r".repeat(APPROVAL_REASON_MAX_LENGTH);

    expect(
      toWireCommandFromStore({ ...base, approvalReason: atBound })
        .approvalReason
    ).toBe(atBound);
    expect(
      toWireCommandFromStore({
        ...base,
        approvalReason: "Genehmigung für Größe\t(dringend)",
      }).approvalReason
    ).toBe("Genehmigung für Größe\t(dringend)");
    expect(toWireCommandFromStore(base).approvalReason).toBeUndefined();
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

  it("rejects a malformed path by returning null, never by throwing", () => {
    // The malformed path is parsed BEFORE the namespace guard, so before ISS-7558
    // this was the one input that broke the declared `| null` contract.
    for (const malformed of MALFORMED_PATHS) {
      const operation = relayOperation({
        commandId: "c1",
        request: request({ path: malformed }),
      });
      expect(() => toWireCommandFromRelayOperation(operation)).not.toThrow();
      expect(toWireCommandFromRelayOperation(operation)).toBeNull();
    }
  });
});

describe("toWireCommandFromRelayOperation — mapping", () => {
  it("resolves the semantic operationId from the path, not the supplied uuid", () => {
    const wire = toWireCommandFromRelayOperation(
      relayOperation({ commandId: "c1", request: request() })
    );

    expect(wire?.operationId).toBe("repos_config");
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
        request: request({ path: `${REPOS}?tag=a&tag=b` }),
      })
    );

    expect(wire?.path).toBe(REPOS);
    expect(wire?.query).toEqual({ tag: ["a", "b"] });
  });

  it("defaults an absent body to null rather than undefined", () => {
    const wire = toWireCommandFromRelayOperation(
      relayOperation({ commandId: "c1", request: request() })
    );

    expect(wire?.body).toBeNull();
  });

  it("falls back to null for a non-JSON-serializable body", () => {
    const wire = toWireCommandFromRelayOperation(
      relayOperation({
        commandId: "c1",
        request: request({ body: Symbol("not-json") }),
      })
    );

    expect(wire).not.toBeNull();
    expect(wire?.body).toBeNull();
  });

  it("rejects a non-JSON-serializable value outside the request body", () => {
    const wire = toWireCommandFromRelayOperation(
      relayOperation({
        commandId: "c1",
        request: request(),
        timeoutMs: Number.POSITIVE_INFINITY,
      })
    );

    expect(wire).toBeNull();
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
    const body = { repo: "acme/web", force: true };
    const wire = toWireCommandFromRelayOperation(
      relayOperation({
        commandId: "c1",
        request: request({ body, headers: { "x-a": "1" } }),
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
    expect(wire?.body).toEqual(body);
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

describe("handleRelayOperationForSocket", () => {
  // `apps/api` has no global mock reset, so the log spies carry across cases.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function fakeSocket() {
    return { id: "socket-1", emit: vi.fn() } as unknown as Socket;
  }

  it("emits and reports acceptance for a convertible operation", () => {
    const socket = fakeSocket();

    const accepted = handleRelayOperationForSocket(
      socket,
      relayOperation({ commandId: "c1", request: request() }) as never,
      TARGET_ID
    );

    expect(accepted).toBe(true);
    expect(socket.emit).toHaveBeenCalledWith(
      "desktop.command",
      expect.objectContaining({ commandId: "c1", path: REPOS })
    );
    expect(socket.emit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        protocolVersion: PROTOCOL_VERSION,
        messageId: expect.any(String),
        timestamp: expect.any(String),
      })
    );
  });

  it("reports rejection and emits nothing for a malformed path", () => {
    // The `false` is what stops `publishOperation` reporting a delivery that did
    // not happen; a bare `return` here is the ISS-7558 bug.
    for (const malformed of MALFORMED_PATHS) {
      const socket = fakeSocket();

      const accepted = handleRelayOperationForSocket(
        socket,
        relayOperation({
          commandId: "c1",
          request: request({ path: malformed }),
        }) as never,
        TARGET_ID
      );

      expect(accepted).toBe(false);
      expect(socket.emit).not.toHaveBeenCalled();
    }
  });

  it("logs a rejection at warn, never at error", () => {
    // Any authenticated caller can drive this branch once per request, so an
    // `error` here is a client-controlled alert channel, not a signal.
    const socket = fakeSocket();

    handleRelayOperationForSocket(
      socket,
      relayOperation({
        commandId: "c1",
        request: request({ path: MALFORMED_PATHS[0] }),
      }) as never,
      TARGET_ID
    );

    expect(log.warn).toHaveBeenCalledWith(
      "Failed to convert relay operation to wire command",
      expect.objectContaining({
        computeTargetId: TARGET_ID,
        targetId: TARGET_ID,
      })
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("reports rejection for a path outside the gateway namespace", () => {
    const socket = fakeSocket();

    const accepted = handleRelayOperationForSocket(
      socket,
      relayOperation({
        commandId: "c1",
        request: request({ path: "/api/documents/1" }),
      }) as never,
      TARGET_ID
    );

    expect(accepted).toBe(false);
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
