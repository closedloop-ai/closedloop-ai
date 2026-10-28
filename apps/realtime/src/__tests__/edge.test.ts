import { log } from "@repo/observability/log";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import {
  joinAckSchema,
  PROTOCOL_VERSION,
  RealtimeEvent,
  refreshAckSchema,
  type WelcomePayload,
  welcomePayloadSchema,
} from "@repo/realtime-contract/protocol";
import { REALTIME_TOKEN_TTL_SECONDS } from "@repo/realtime-contract/token";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGNAL_MAX_PACKET_BYTES } from "../classes/signal";
import { SOCKET_ERROR_EVENT } from "../edge/connection";
import { ORIGIN_REFUSED_EVENT } from "../edge/socket-server";
import {
  ALLOWED_ORIGIN,
  connectError,
  type EdgeHarness,
  emitWithAck,
  expiredTokenFor,
  nextEvent,
  ORG_A,
  ORG_B,
  OTHER_SIGNER,
  openClient,
  startEdge,
  tokenFor,
  USER_A,
  USER_B,
  validAuth,
} from "./edge-harness";

const CHANNEL = `comments:${ORG_A}:doc-1`;
const EXPIRY_TEST_TIMEOUT_MS = 5000;

let edge: EdgeHarness;
let clockSkewMs = 0;
const clients: ClientSocket[] = [];

function track(client: ClientSocket): ClientSocket {
  clients.push(client);
  return client;
}

async function connectedClient(token: string): Promise<{
  client: ClientSocket;
  welcome: WelcomePayload;
}> {
  const client = track(openClient(edge.url, validAuth(token)));
  const welcome = await nextEvent<WelcomePayload>(
    client,
    RealtimeEvent.Welcome
  );
  return { client, welcome };
}

beforeEach(async () => {
  clockSkewMs = 0;
  edge = await startEdge({ now: () => Date.now() + clockSkewMs });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
  await edge.close();
});

describe("handshake auth", () => {
  it("admits a valid token and welcomes with the connection id and protocol", async () => {
    const { client, welcome } = await connectedClient(
      await tokenFor(ORG_A, USER_A)
    );

    expect(welcomePayloadSchema.parse(welcome)).toEqual({
      connectionId: client.id,
      protocol: PROTOCOL_VERSION,
    });
  });

  it.each([
    [
      "no token",
      async () => ({ protocol: PROTOCOL_VERSION, clientVersion: "t" }),
      RealtimeErrorCode.Unauthorized,
    ],
    [
      "a token signed with another key",
      async () => validAuth(await tokenFor(ORG_A, USER_A, OTHER_SIGNER)),
      RealtimeErrorCode.Unauthorized,
    ],
    [
      "an expired token",
      async () => validAuth(await expiredTokenFor(ORG_A, USER_A)),
      RealtimeErrorCode.TokenExpired,
    ],
    [
      "an unsupported protocol",
      async () => ({
        ...validAuth(await tokenFor(ORG_A, USER_A)),
        protocol: PROTOCOL_VERSION + 1,
      }),
      RealtimeErrorCode.UnknownKind,
    ],
    [
      "no clientVersion",
      async () => ({
        token: await tokenFor(ORG_A, USER_A),
        protocol: PROTOCOL_VERSION,
      }),
      RealtimeErrorCode.Unauthorized,
    ],
  ])(
    "rejects %s with connect_error carrying the code",
    async (_label, auth, code) => {
      const client = track(openClient(edge.url, await auth()));

      expect(await connectError(client)).toEqual({ code });
    }
  );

  it("reads the token only from the auth payload, never the URL", async () => {
    const token = await tokenFor(ORG_A, USER_A);
    const viaQuery = track(
      openClient(
        edge.url,
        { protocol: PROTOCOL_VERSION, clientVersion: "t" },
        { query: { token } }
      )
    );
    expect(await connectError(viaQuery)).toEqual({
      code: RealtimeErrorCode.Unauthorized,
    });

    const { client } = await connectedClient(token);
    const [serverSocket] = await edge.io.in(client.id ?? "").fetchSockets();
    expect(serverSocket?.handshake.url).not.toContain(token);
  });

  it("refuses a browser origin that is not on the allow-list", async () => {
    const logWarn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const token = await tokenFor(ORG_A, USER_A);
    const refused = track(
      openClient(edge.url, validAuth(token), {
        extraHeaders: { origin: "https://evil.example.test" },
      })
    );
    await expect(connectError(refused)).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: ORIGIN_REFUSED_EVENT,
        origin: "https://evil.example.test",
      })
    );
    logWarn.mockClear();

    const allowed = track(
      openClient(edge.url, validAuth(token), {
        extraHeaders: { origin: ALLOWED_ORIGIN },
      })
    );
    await nextEvent(allowed, RealtimeEvent.Welcome);
    expect(logWarn).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: ORIGIN_REFUSED_EVENT })
    );
  });
});

describe("session semantics", () => {
  it("starts a fresh session on reconnect, with nothing recovered", async () => {
    const recovered: boolean[] = [];
    edge.io.on("connection", (socket) => recovered.push(socket.recovered));
    const { client, welcome } = await connectedClient(
      await tokenFor(ORG_A, USER_A)
    );
    // A transport drop, not a client disconnect: only an involuntary
    // disconnect is ever eligible for state recovery.
    const dropped = nextEvent<string>(client, "disconnect");
    client.io.engine.close();
    await dropped;

    const reconnected = nextEvent<WelcomePayload>(
      client,
      RealtimeEvent.Welcome
    );
    client.connect();
    const second = await reconnected;

    expect(second.connectionId).not.toBe(welcome.connectionId);
    expect(recovered).toEqual([false, false]);
  });

  it("ignores an event with no handler and keeps serving the connection", async () => {
    const { client } = await connectedClient(await tokenFor(ORG_A, USER_A));

    client.emit("rt:from-the-future", { anything: true });

    expect(
      await emitWithAck(client, RealtimeEvent.Leave, { channel: CHANNEL })
    ).toEqual({ ok: true });
    expect(client.connected).toBe(true);
  });

  it("survives a malformed frame and keeps serving other connections", async () => {
    const logError = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const { client } = await connectedClient(await tokenFor(ORG_A, USER_A));
    const disconnected = nextEvent<string>(client, "disconnect");

    client.io.engine.write("2[");

    expect(await disconnected).toBe("transport close");
    expect(logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: SOCKET_ERROR_EVENT })
    );
    const { client: other } = await connectedClient(
      await tokenFor(ORG_A, USER_A)
    );
    expect(
      await emitWithAck(other, RealtimeEvent.Leave, { channel: CHANNEL })
    ).toEqual({ ok: true });
  });

  it("survives a client-sent error event without logging its payload", async () => {
    const logError = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const { client } = await connectedClient(await tokenFor(ORG_A, USER_A));

    client.emit("error", "client-sent content");

    expect(
      await emitWithAck(client, RealtimeEvent.Leave, { channel: CHANNEL })
    ).toEqual({ ok: true });
    expect(logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: SOCKET_ERROR_EVENT, error: "string" })
    );
  });

  it("refuses an incoming packet larger than the signal class limit", async () => {
    const { client } = await connectedClient(await tokenFor(ORG_A, USER_A));
    const disconnected = nextEvent<string>(client, "disconnect");

    client.emit(RealtimeEvent.Leave, {
      channel: "x".repeat(SIGNAL_MAX_PACKET_BYTES + 1),
    });

    expect(await disconnected).toBe("transport close");
  });
});

describe("rt:join, rt:leave and rt:refresh acknowledgements", () => {
  it.each([RealtimeEvent.Join, RealtimeEvent.Leave, RealtimeEvent.Refresh])(
    "acks a malformed %s payload with internal",
    async (event) => {
      const { client } = await connectedClient(await tokenFor(ORG_A, USER_A));

      expect(
        await emitWithAck(client, event, { channel: 42, token: 42 })
      ).toEqual({
        ok: false,
        code: RealtimeErrorCode.Internal,
      });
      expect(await emitWithAck(client, event)).toEqual({
        ok: false,
        code: RealtimeErrorCode.Internal,
      });
    }
  );

  it("tolerates a missing ack callback", async () => {
    const { client } = await connectedClient(await tokenFor(ORG_A, USER_A));

    client.emit(RealtimeEvent.Join, { channel: CHANNEL });
    client.emit(RealtimeEvent.Refresh, { token: "not-a-token" });

    expect(
      await emitWithAck(client, RealtimeEvent.Leave, { channel: CHANNEL })
    ).toEqual({ ok: true });
  });

  it("refuses a join that no grant covers with forbidden", async () => {
    const { client } = await connectedClient(await tokenFor(ORG_A, USER_A));

    const ack = joinAckSchema.parse(
      await emitWithAck(client, RealtimeEvent.Join, { channel: CHANNEL })
    );

    expect(ack).toEqual({ ok: false, code: RealtimeErrorCode.Forbidden });
  });

  it("refreshes in place and acks expiresAt in epoch milliseconds", async () => {
    const { client } = await connectedClient(await tokenFor(ORG_A, USER_A));
    const fresh = await tokenFor(ORG_A, USER_A);
    const { exp, jti } = tokenClaims(fresh);

    const ack = refreshAckSchema.parse(
      await emitWithAck(client, RealtimeEvent.Refresh, { token: fresh })
    );

    expect(ack).toEqual({ ok: true, expiresAt: exp * 1000 });
    expect(client.connected).toBe(true);
    const [serverSocket] = await edge.io.in(client.id ?? "").fetchSockets();
    expect(serverSocket?.data.claims.jti).toBe(jti);
  });

  it(
    "re-arms the token expiry against the refreshed token",
    async () => {
      const { client } = await connectedClient(await tokenFor(ORG_A, USER_A));
      const fresh = await tokenFor(ORG_A, USER_A);
      const expired = nextEvent<unknown>(client, RealtimeEvent.Error);
      // The service clock now reads past the fresh token's exp, so only a
      // timer the refresh re-arms fires; the one armed at connect is ~10 min out.
      clockSkewMs = (REALTIME_TOKEN_TTL_SECONDS + 1) * 1000;

      await emitWithAck(client, RealtimeEvent.Refresh, { token: fresh });

      expect(await expired).toEqual({ code: RealtimeErrorCode.TokenExpired });
    },
    EXPIRY_TEST_TIMEOUT_MS
  );

  it.each([
    ["another organization", ORG_B, USER_A],
    ["another user", ORG_A, USER_B],
  ])(
    "refuses a refresh token for %s with forbidden",
    async (_label, org, sub) => {
      const { client } = await connectedClient(await tokenFor(ORG_A, USER_A));

      expect(
        await emitWithAck(client, RealtimeEvent.Refresh, {
          token: await tokenFor(org, sub),
        })
      ).toEqual({ ok: false, code: RealtimeErrorCode.Forbidden });
    }
  );

  it("answers a refresh with a bad or expired token with its code", async () => {
    const { client } = await connectedClient(await tokenFor(ORG_A, USER_A));

    expect(
      await emitWithAck(client, RealtimeEvent.Refresh, {
        token: await tokenFor(ORG_A, USER_A, OTHER_SIGNER),
      })
    ).toEqual({ ok: false, code: RealtimeErrorCode.Unauthorized });
    expect(
      await emitWithAck(client, RealtimeEvent.Refresh, {
        token: await expiredTokenFor(ORG_A, USER_A),
      })
    ).toEqual({ ok: false, code: RealtimeErrorCode.TokenExpired });
  });
});

function tokenClaims(token: string): { exp: number; jti: string } {
  return JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString()
  );
}
