import { ApiKeySource } from "@repo/database/generated/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-5291: the Socket.IO CONNECT-time auth boundary for the Desktop gateway.
 *
 * This middleware is what stands between an arbitrary WebSocket client and a
 * credentialed namespace that can dispatch commands to a developer's machine.
 * It was reached by no test: `resolveDesktopAuthContext`, `extractApiKey`,
 * `toRequestHeaders`, `buildDesktopSocketPopVerificationRequest` and
 * `initDesktopGatewaySocketServer` all had zero calls.
 *
 * Its own comment records why it is hand-rolled rather than sharing the HTTP
 * resolver — `resolve-any-auth-context` transitively imports `server-only`,
 * which throws under the custom tsx socket server. A duplicated auth path that
 * nothing exercises is the worst version of that trade, so these tests pin each
 * rejection reason SEPARATELY: a single "unauthorized" assertion would stay
 * green if the scope check, the active-user check, or the PoP check were
 * dropped, since the others still reject.
 *
 * `socket.io`'s Server is faked to capture the namespace middleware. That is the
 * only way in — the middleware is a closure created inside
 * `initDesktopGatewaySocketServer` and is not otherwise reachable.
 */

const {
  mockVerifyKeyWithMetadata,
  mockTouchLastUsedAt,
  mockFindById,
  mockGetPopFailure,
  mockIsTrustedOrigin,
} = vi.hoisted(() => ({
  mockVerifyKeyWithMetadata: vi.fn(),
  mockTouchLastUsedAt: vi.fn(),
  mockFindById: vi.fn(),
  mockGetPopFailure: vi.fn(),
  mockIsTrustedOrigin: vi.fn(),
}));

type Middleware = (socket: unknown, next: (error?: Error) => void) => void;
type ConnectionHandler = (socket: unknown) => void;

const captured: {
  namespaces: string[];
  middlewareByNamespace: Map<string, Middleware>;
  connectionByNamespace: Map<string, ConnectionHandler>;
  serverOptions: Record<string, unknown> | null;
  constructed: number;
} = {
  namespaces: [],
  middlewareByNamespace: new Map(),
  connectionByNamespace: new Map(),
  serverOptions: null,
  constructed: 0,
};

function resetCaptured() {
  captured.namespaces = [];
  captured.middlewareByNamespace = new Map();
  captured.connectionByNamespace = new Map();
  captured.serverOptions = null;
  captured.constructed = 0;
}

vi.mock("socket.io", () => ({
  Server: class {
    constructor(_httpServer: unknown, options: Record<string, unknown>) {
      captured.serverOptions = options;
      captured.constructed += 1;
    }
    // Keyed by the namespace argument, the way the real `of()` is: handlers
    // registered on some other namespace must NOT satisfy a lookup for
    // `/desktop-gateway`, or the suite would stay green on a namespace rename.
    of(namespace: string) {
      captured.namespaces.push(namespace);
      return {
        use: (fn: Middleware) => {
          captured.middlewareByNamespace.set(namespace, fn);
        },
        on: (event: string, fn: ConnectionHandler) => {
          if (event === "connection") {
            captured.connectionByNamespace.set(namespace, fn);
          }
        },
      };
    }
    close(cb: (error?: Error) => void) {
      cb();
    }
  },
}));

vi.mock("@repo/analytics/node", () => ({
  nodeAnalytics: { capture: vi.fn() },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../app/api-keys/service", () => ({
  apiKeysService: {
    verifyKeyWithMetadata: mockVerifyKeyWithMetadata,
    touchLastUsedAt: mockTouchLastUsedAt,
  },
}));

vi.mock("../../app/users/service", () => ({
  usersService: { findById: mockFindById },
}));

vi.mock("../auth/desktop-managed-pop", () => ({
  getDesktopManagedPopRequestFailure: mockGetPopFailure,
}));

vi.mock("../trusted-origins", () => ({
  isTrustedOrigin: mockIsTrustedOrigin,
}));

vi.mock("../../app/compute-targets/service", () => ({
  computeTargetsService: {
    heartbeat: vi.fn(),
    register: vi.fn(),
    setOnlineState: vi.fn(),
    updateOwned: vi.fn(),
  },
  isComputeTargetGatewayConflictResult: () => false,
}));

vi.mock("../relay-event-bus", () => ({
  relayEventBus: {
    clearOperationBacklog: vi.fn(),
    subscribeOperations: vi.fn(),
    subscribeTargetConnection: vi.fn(),
  },
}));

vi.mock("../desktop-command-store", () => ({
  desktopCommandStore: {
    getCommandById: vi.fn(),
    ingestCommandEvent: vi.fn(),
    listNonTerminalDispatchCommands: vi.fn(),
  },
}));

vi.mock("../desktop-agent-sessions-handler", () => ({
  handleDesktopAgentSessionsEvent: vi.fn(),
}));

vi.mock("../desktop-analytics-handler", () => ({
  handleDesktopAnalyticsEvent: vi.fn(),
}));

vi.mock("../desktop-command-ack-handler", () => ({
  acknowledgeDesktopCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../desktop-relay-event-bridge", () => ({
  publishLegacyRelayEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../desktop-telemetry-handler", () => ({
  handleTelemetryEvent: vi.fn().mockReturnValue({ ok: true, emits: [] }),
}));

vi.mock("../agent-session-sync-feature", () => ({
  isAgentSessionSyncSupportedForUser: vi.fn(),
}));

import { initDesktopGatewaySocketServer } from "../desktop-gateway-socket-server";

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const API_KEY = "sk_live_abc123";
/**
 * Desktop classifies a connect_error by matching `unauthorized`/`forbidden` in
 * the message and stops retrying with the same credential. Any other wording
 * drops the client into the generic reconnect loop instead, so the string is
 * part of the contract, not a log detail.
 */
const UNAUTHORIZED_MESSAGE = "Unauthorized";
/** The path Desktop signs into its PoP proof for API-key validation. */
const POP_VERIFICATION_PATH = "/internal/api-keys/verify";

let nextSocketId = 0;

function makeHandshakeSocket(handshake: {
  auth?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}) {
  nextSocketId += 1;
  return {
    id: `auth-socket-${nextSocketId}`,
    connected: true,
    data: {},
    handshake: {
      auth: handshake.auth ?? {},
      headers: handshake.headers ?? {},
    },
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
  };
}

/**
 * Build a fresh server and return the connect middleware registered on the
 * gateway namespace. Spelled as a literal rather than imported from the server:
 * Desktop's socket.io-client connects to this exact path, so a rename is a
 * break even when both sides of the server agree on the new constant.
 */
const DESKTOP_GATEWAY_NAMESPACE = "/desktop-gateway";

function freshMiddleware(): Middleware {
  resetCaptured();
  // A distinct httpServer per call: the module memoizes instances per server,
  // so reusing one would return the cached instance and never re-register.
  initDesktopGatewaySocketServer({ id: nextSocketId } as never);
  const middleware = captured.middlewareByNamespace.get(
    DESKTOP_GATEWAY_NAMESPACE
  );
  if (!middleware) {
    throw new Error(
      `no connect middleware registered on ${DESKTOP_GATEWAY_NAMESPACE}; saw ${JSON.stringify(captured.namespaces)}`
    );
  }
  return middleware;
}

/** Run the middleware and resolve with the error it passed to `next`. */
function runMiddleware(
  middleware: Middleware,
  socket: unknown
): Promise<Error | undefined> {
  return new Promise((resolve) => {
    middleware(socket, resolve);
  });
}

function keyContext(over: Record<string, unknown> = {}) {
  return {
    apiKeyId: "key-1",
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    scopes: ["read", "write"],
    source: ApiKeySource.DESKTOP_MANAGED,
    gatewayId: "gateway-1",
    boundPublicKey: "pub-key-1",
    ...over,
  };
}

function happyPath() {
  mockVerifyKeyWithMetadata.mockResolvedValue(keyContext());
  mockFindById.mockResolvedValue({
    id: USER_ID,
    active: true,
    clerkId: "clerk-1",
  });
  mockGetPopFailure.mockResolvedValue(null);
  mockTouchLastUsedAt.mockResolvedValue(undefined);
  mockIsTrustedOrigin.mockReturnValue(true);
}

describe("desktop gateway socket auth — accepting a connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
  });

  it("admits a valid key and stores the resolved context on the socket", async () => {
    const socket = makeHandshakeSocket({ auth: { token: API_KEY } });

    const error = await runMiddleware(freshMiddleware(), socket);

    expect(error).toBeUndefined();
    // The connection handler reads the context off `socket.data`; a middleware
    // that admitted without storing it would disconnect every client instead.
    expect(socket.data).toMatchObject({
      authContext: {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        clerkUserId: "clerk-1",
        apiKeySource: ApiKeySource.DESKTOP_MANAGED,
        apiKeyGatewayId: "gateway-1",
        apiKeyBoundPublicKey: "pub-key-1",
      },
    });
    // The account re-read is tenant-scoped by argument, not filtered after the
    // fact: a swapped or dropped organizationId would resolve the user against
    // whichever org answered first and admit the socket on that basis.
    expect(mockFindById).toHaveBeenCalledWith(USER_ID, ORGANIZATION_ID);
  });

  it("does not update the key's last-used timestamp during verification", async () => {
    const socket = makeHandshakeSocket({ auth: { token: API_KEY } });

    await runMiddleware(freshMiddleware(), socket);

    // Verification is a read; the write is deliberately deferred to a
    // fire-and-forget touch so a slow write cannot stall the handshake.
    expect(mockVerifyKeyWithMetadata).toHaveBeenCalledWith(API_KEY, {
      updateLastUsedAt: false,
    });
    expect(mockTouchLastUsedAt).toHaveBeenCalledWith("key-1");
  });

  it("still admits when the deferred last-used write rejects", async () => {
    mockTouchLastUsedAt.mockRejectedValue(new Error("db down"));
    const socket = makeHandshakeSocket({ auth: { token: API_KEY } });

    const error = await runMiddleware(freshMiddleware(), socket);

    // Bookkeeping must never be able to deny a valid client.
    expect(error).toBeUndefined();
  });
});

describe("desktop gateway socket auth — where the key may come from", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
  });

  it.each([
    ["handshake auth.token", { auth: { token: API_KEY } }],
    ["handshake auth.apiKey", { auth: { apiKey: API_KEY } }],
    [
      "an Authorization Bearer header",
      { headers: { authorization: `Bearer ${API_KEY}` } },
    ],
  ])("accepts a key supplied via %s", async (_label, handshake) => {
    const socket = makeHandshakeSocket(handshake);

    const error = await runMiddleware(freshMiddleware(), socket);

    expect(error).toBeUndefined();
    expect(mockVerifyKeyWithMetadata).toHaveBeenCalledWith(
      API_KEY,
      expect.anything()
    );
  });

  it("prefers the handshake auth field over the header", async () => {
    const socket = makeHandshakeSocket({
      auth: { token: API_KEY },
      headers: { authorization: "Bearer sk_live_from_header" },
    });

    await runMiddleware(freshMiddleware(), socket);

    expect(mockVerifyKeyWithMetadata).toHaveBeenCalledWith(
      API_KEY,
      expect.anything()
    );
  });

  it("trims whitespace from a Bearer header", async () => {
    const socket = makeHandshakeSocket({
      headers: { authorization: `Bearer   ${API_KEY}  ` },
    });

    await runMiddleware(freshMiddleware(), socket);

    expect(mockVerifyKeyWithMetadata).toHaveBeenCalledWith(
      API_KEY,
      expect.anything()
    );
  });

  it.each([
    ["no credential at all", {}],
    ["a non-string auth token", { auth: { token: 42 } }],
    [
      "an Authorization header without the Bearer scheme",
      {
        headers: { authorization: API_KEY },
      },
    ],
    [
      "a non-string Authorization header",
      {
        headers: { authorization: ["Bearer", API_KEY] },
      },
    ],
    ["a token that is not a live secret key", { auth: { token: "sk_test_x" } }],
    ["an empty Bearer token", { headers: { authorization: "Bearer " } }],
  ])("rejects %s without calling the key service", async (_label, handshake) => {
    const socket = makeHandshakeSocket(handshake);

    const error = await runMiddleware(freshMiddleware(), socket);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(UNAUTHORIZED_MESSAGE);
    // The `sk_live_` prefix test is the cheap gate in front of a database
    // lookup; letting a malformed token through would turn every unauthenticated
    // connect attempt into a query.
    expect(mockVerifyKeyWithMetadata).not.toHaveBeenCalled();
  });
});

describe("desktop gateway socket auth — each rejection reason on its own", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
  });

  it("rejects an unverifiable key", async () => {
    mockVerifyKeyWithMetadata.mockResolvedValue(null);

    const error = await runMiddleware(
      freshMiddleware(),
      makeHandshakeSocket({ auth: { token: API_KEY } })
    );

    expect(error).toBeInstanceOf(Error);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it("rejects a read-only key", async () => {
    mockVerifyKeyWithMetadata.mockResolvedValue(
      keyContext({ scopes: ["read"] })
    );

    const error = await runMiddleware(
      freshMiddleware(),
      makeHandshakeSocket({ auth: { token: API_KEY } })
    );

    // This namespace dispatches commands to a developer's machine, so a
    // read-scoped key must not open it. Pinned separately because every other
    // check in the ladder would still reject on its own.
    expect(error).toBeInstanceOf(Error);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it.each([
    ["the user no longer exists", null],
    ["the user is deactivated", { id: USER_ID, active: false, clerkId: "c" }],
  ])("rejects when %s", async (_label, user) => {
    mockFindById.mockResolvedValue(user);

    const error = await runMiddleware(
      freshMiddleware(),
      makeHandshakeSocket({ auth: { token: API_KEY } })
    );

    // A key outlives the account it was minted for, so deactivation has to be
    // checked at connect time rather than trusted from the key row.
    expect(error).toBeInstanceOf(Error);
    expect(mockGetPopFailure).not.toHaveBeenCalled();
  });

  it("rejects when proof-of-possession fails", async () => {
    mockGetPopFailure.mockResolvedValue({ status: 401 });

    const error = await runMiddleware(
      freshMiddleware(),
      makeHandshakeSocket({ auth: { token: API_KEY } })
    );

    expect(error).toBeInstanceOf(Error);
    expect(mockTouchLastUsedAt).not.toHaveBeenCalled();
  });

  it("rejects, rather than admitting, when the key service throws", async () => {
    mockVerifyKeyWithMetadata.mockRejectedValue(new Error("db down"));

    const error = await runMiddleware(
      freshMiddleware(),
      makeHandshakeSocket({ auth: { token: API_KEY } })
    );

    // Fail CLOSED: an outage in the auth dependency must not become an open
    // door onto local command execution — and it must fail closed in the same
    // words, so a thrown dependency is not misread by Desktop as a transient
    // fault worth reconnecting through.
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(UNAUTHORIZED_MESSAGE);
  });

  it("does not leave a partial auth context on a rejected socket", async () => {
    mockGetPopFailure.mockResolvedValue({ status: 401 });
    const socket = makeHandshakeSocket({ auth: { token: API_KEY } });

    await runMiddleware(freshMiddleware(), socket);

    // The connection handler admits on the presence of `authContext` alone, so
    // a rejected handshake that still wrote one would be a bypass.
    expect(
      (socket.data as { authContext?: unknown }).authContext
    ).toBeUndefined();
  });
});

describe("desktop gateway socket auth — proof-of-possession request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
  });

  it("forwards the handshake headers, flattening repeats, onto the PoP request", async () => {
    const socket = makeHandshakeSocket({
      auth: { token: API_KEY },
      headers: {
        "x-signature": "sig-1",
        "x-repeated": ["a", "b"],
        "x-dropped": undefined,
      },
    });

    await runMiddleware(freshMiddleware(), socket);

    const request = mockGetPopFailure.mock.calls[0]?.[0]?.request as Request;
    expect(request.method).toBe("POST");
    // Desktop signs the method and pathname into the PoP proof, so the synthetic
    // request has to reproduce the same path the relay/API validation uses —
    // drifting it here rejects every real signature while the mock stays happy.
    expect(new URL(request.url).pathname).toBe(POP_VERIFICATION_PATH);
    expect(request.headers.get("x-signature")).toBe("sig-1");
    // A repeated header is appended, not overwritten — dropping one would
    // silently invalidate a proof that spans multiple values.
    expect(request.headers.get("x-repeated")).toBe("a, b");
    expect(request.headers.has("x-dropped")).toBe(false);
  });

  it("passes the verified key context with the resolved Clerk id", async () => {
    await runMiddleware(
      freshMiddleware(),
      makeHandshakeSocket({ auth: { token: API_KEY } })
    );

    // The Clerk id comes from the freshly-read user, not from the key row —
    // that is what makes the PoP check reflect current account state.
    expect(mockGetPopFailure.mock.calls[0]?.[0]?.keyContext).toMatchObject({
      apiKeyId: "key-1",
      clerkUserId: "clerk-1",
    });
  });
});

describe("initDesktopGatewaySocketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
    resetCaptured();
  });

  it("registers the auth middleware on the /desktop-gateway namespace", () => {
    initDesktopGatewaySocketServer({ id: "namespace" } as never);

    // Desktop dials this exact namespace. Registering the credentialed
    // handlers anywhere else leaves that client unable to connect at all,
    // which no amount of middleware-level coverage would show.
    expect(captured.namespaces).toEqual([DESKTOP_GATEWAY_NAMESPACE]);
    expect(captured.middlewareByNamespace.has(DESKTOP_GATEWAY_NAMESPACE)).toBe(
      true
    );
    expect(captured.connectionByNamespace.has(DESKTOP_GATEWAY_NAMESPACE)).toBe(
      true
    );
  });

  it("returns the same instance for one http server instead of rebuilding", () => {
    const httpServer = { id: "http-1" } as never;

    const first = initDesktopGatewaySocketServer(httpServer);
    const second = initDesktopGatewaySocketServer(httpServer);

    // Re-registering the namespace would double every handler, so each hello
    // and every command ack would be processed twice.
    expect(second).toBe(first);
    expect(captured.constructed).toBe(1);
  });

  it.each([
    ["a Node client that sends no Origin", undefined, true, null],
    [
      "a browser on a trusted origin",
      "https://app.example",
      true,
      "https://app.example",
    ],
    [
      "a browser on an untrusted origin",
      "https://evil.example",
      false,
      "https://evil.example",
    ],
  ])("resolves CORS for %s", (_label, origin, allowed, consultedWith) => {
    mockIsTrustedOrigin.mockReturnValue(allowed);
    initDesktopGatewaySocketServer({ id: `cors-${origin}` } as never);
    const cors = captured.serverOptions?.cors as {
      origin: (
        origin: string | undefined,
        cb: (error: unknown, allow: boolean) => void
      ) => void;
    };

    const callbackCalls: [unknown, boolean][] = [];
    cors.origin(origin, (error, allow) => {
      callbackCalls.push([error, allow]);
    });

    // Desktop workers connect over Node and send no Origin, so absence must
    // be allowed — but anything that DOES send one is a browser and has to
    // clear the same allowlist the HTTP API uses. The callback is answered
    // exactly once, with no error, so a silent or double answer is a failure
    // rather than an inherited verdict.
    expect(callbackCalls).toEqual([[null, allowed]]);
    // The allowlist must be consulted with the origin the client actually
    // presented: a fixed trusted value, or the Node row consulting it at all,
    // would let one hardcoded answer satisfy every row.
    expect(mockIsTrustedOrigin.mock.calls).toEqual(
      consultedWith === null ? [] : [[consultedWith]]
    );
  });

  it("restricts the namespace to the websocket transport", () => {
    initDesktopGatewaySocketServer({ id: "transport" } as never);

    // The CORS comment above depends on this: re-adding HTTP long-polling would
    // expose the credentialed namespace to browsers differently.
    expect(captured.serverOptions?.transports).toEqual(["websocket"]);
  });
});
