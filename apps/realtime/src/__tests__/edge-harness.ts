import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Grant } from "@repo/realtime-contract/grants";
import {
  PROTOCOL_VERSION,
  REALTIME_SOCKET_PATH,
  RealtimeEvent,
  type WelcomePayload,
} from "@repo/realtime-contract/protocol";
import { createRevocations } from "@repo/realtime-contract/revocations";
import {
  issueRealtimeToken,
  type RealtimeTokenPublicKeys,
  type RealtimeTokenSigner,
} from "@repo/realtime-contract/token";
import {
  type Socket as ClientSocket,
  io as connectClient,
} from "socket.io-client";
import { vi } from "vitest";
import { attachEdge, type EdgeOptions } from "../edge/connection";
import {
  createRealtimeSocketServer,
  type RealtimeServer,
} from "../edge/socket-server";
import { composeRealtimeService, type RealtimeServiceDeps } from "../service";

/** An RS256 key pair standing in for the KMS key apps/api signs with (ISS-11966). */
const TEST_KID = "0b2c4d6e-1f3a-4b5c-8d7e-9f0a1b2c3d4e";
const TEST_RSA = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const TEST_PUBLIC_KEYS: RealtimeTokenPublicKeys = new Map([
  [TEST_KID, TEST_RSA.publicKey],
]);
/** {@link TEST_PUBLIC_KEYS} as `REALTIME_TOKEN_PUBLIC_KEYS` carries it. */
export const TEST_PUBLIC_KEYS_JSON = JSON.stringify({
  [TEST_KID]: TEST_RSA.publicKey.export({ type: "spki", format: "pem" }),
});
export const TEST_SIGNER = rsaSigner(TEST_KID, TEST_RSA.privateKey);
/** Signs under the service's `kid` with a key the service does not hold. */
export const OTHER_SIGNER = rsaSigner(
  TEST_KID,
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
);

export const ORG_A = "0190a2b4-0000-7000-8000-00000000000a";
export const ORG_B = "0190a2b4-0000-7000-8000-00000000000b";
export const USER_A = "user_a";
export const USER_B = "user_b";
export const ALLOWED_ORIGIN = "https://app.example.test";

export type EdgeHarness = {
  io: RealtimeServer;
  url: string;
  close: () => Promise<void>;
};

export async function startEdge(
  options: Partial<
    Pick<EdgeOptions, "now" | "isDraining" | "admitter" | "revocations">
  > = {}
): Promise<EdgeHarness> {
  const httpServer: HttpServer = createServer();
  const io = createRealtimeSocketServer(httpServer, {
    pingTimeoutMs: undefined,
    allowedOrigins: [ALLOWED_ORIGIN],
  });
  attachEdge(io, {
    tokenKeys: { publicKeys: TEST_PUBLIC_KEYS },
    ...options,
    revocations: options.revocations ?? createRevocations(),
  });
  return await listenEdge(httpServer, io);
}

/**
 * The socket server as `composeRealtimeService` builds it, so the delivery
 * class runtimes are started as in production.
 */
export async function startComposedEdge(
  options: Partial<
    Pick<RealtimeServiceDeps, "admitter" | "startBus" | "revocations">
  > = {},
  httpServer: HttpServer = createServer()
): Promise<EdgeHarness> {
  const { io } = composeRealtimeService(
    httpServer,
    {
      tokenPublicKeys: TEST_PUBLIC_KEYS,
      pingTimeoutMs: undefined,
      allowedOrigins: [ALLOWED_ORIGIN],
      drainWindowMs: 20_000,
    },
    {
      random: Math.random,
      flushTelemetry: async () => undefined,
      exit: () => undefined,
      admitter: options.admitter,
      revocations: options.revocations ?? createRevocations(),
      startBus: options.startBus,
    }
  );
  return await listenEdge(httpServer, io);
}

/** Serves an already composed socket server on an ephemeral port. */
export async function listenEdge(
  httpServer: HttpServer,
  io: RealtimeServer
): Promise<EdgeHarness> {
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const { port } = httpServer.address() as AddressInfo;
  return {
    io,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        io.close(() => resolve());
      }),
  };
}

/** Signed RS256 as apps/api's KMS signer does. */
export async function tokenFor(
  org: string,
  sub: string,
  signer: RealtimeTokenSigner = TEST_SIGNER,
  grants: Grant[] = []
): Promise<string> {
  const issued = await issueRealtimeToken({ sub, org, grants }, { signer });
  return issued.token;
}

/** Signed with the service's key, under `kid`. */
export function kidTokenFor(
  org: string,
  sub: string,
  kid: string
): Promise<string> {
  return tokenFor(org, sub, rsaSigner(kid, TEST_RSA.privateKey));
}

export function grantedTokenFor(
  org: string,
  sub: string,
  grants: Grant[]
): Promise<string> {
  return tokenFor(org, sub, TEST_SIGNER, grants);
}

/** Opens a client, tracks it for teardown, and resolves once it is welcomed. */
export async function welcomedClient(
  url: string,
  token: string,
  tracked: ClientSocket[]
): Promise<{ client: ClientSocket; welcome: WelcomePayload }> {
  const client = openClient(url, validAuth(token));
  tracked.push(client);
  const welcome = await nextEvent<WelcomePayload>(
    client,
    RealtimeEvent.Welcome
  );
  return { client, welcome };
}

/** Issued with the clock pinned an hour back, so it is already expired. */
export async function expiredTokenFor(
  org: string,
  sub: string
): Promise<string> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    return await tokenFor(org, sub);
  } finally {
    vi.useRealTimers();
  }
}

export function validAuth(token: string): Record<string, unknown> {
  return { token, protocol: PROTOCOL_VERSION, clientVersion: "test/1.0.0" };
}

export function openClient(
  url: string,
  auth: Record<string, unknown>,
  extra: Parameters<typeof connectClient>[1] = {}
): ClientSocket {
  return connectClient(url, {
    path: REALTIME_SOCKET_PATH,
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    auth,
    ...extra,
  });
}

export function connectError(client: ClientSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    client.once("connect", () => reject(new Error("connected unexpectedly")));
    client.once("connect_error", (error: Error & { data?: unknown }) =>
      resolve(error.data)
    );
  });
}

export function nextEvent<T>(client: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    client.once(event, (payload: T) => resolve(payload));
  });
}

export function emitWithAck(
  client: ClientSocket,
  event: string,
  ...args: unknown[]
): Promise<unknown> {
  return client.timeout(5000).emitWithAck(event, ...args);
}

function rsaSigner(kid: string, privateKey: KeyObject): RealtimeTokenSigner {
  return {
    kid,
    sign: async (signingInput) => sign("sha256", signingInput, privateKey),
  };
}
