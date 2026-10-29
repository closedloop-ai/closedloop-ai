import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  HocuspocusProvider,
  MessageType,
  type onMessageParameters,
} from "@hocuspocus/provider";
import type { Server } from "@hocuspocus/server";
import { OIDC_CONFIG } from "@repo/http-service/test-support/oidc-fixture";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { GrantAccess } from "@repo/realtime-contract/grants";
import { REALTIME_TOKEN_TTL_SECONDS } from "@repo/realtime-contract/token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import { createDocSyncServer } from "../server";
import type { DocumentStorage } from "../storage/document-storage";
import { DOCUMENT_NAME, documentToken, PUBLIC_KEYS } from "./auth/test-tokens";
import { waitFor } from "./integration/test-schema";

const TEXT = "content";
const ALLOWED_ORIGIN = "http://localhost:3000";
const HTTP_SWITCHING_PROTOCOLS = 101;
const HTTP_FORBIDDEN = 403;
/** A Yjs update the server did not apply, answered with SyncStatus 0. */
const NOT_APPLIED = 0;

type AuthOutcome = { authenticated: boolean; reason?: string };

let started: { server: Server; shutdown: () => Promise<void> } | undefined;
const providers: HocuspocusProvider[] = [];

/**
 * Real token authentication over the Database extension. Persistence has its
 * own Postgres suite; here storage loads nothing and keeps nothing.
 */
async function start(): Promise<{ server: Server; port: number }> {
  const storage: DocumentStorage = {
    fetch: () => Promise.resolve(null),
    store: () => Promise.resolve(),
    exists: () => Promise.resolve(false),
    delete: () => Promise.resolve(false),
    listNames: () => Promise.resolve([]),
    close: () => Promise.resolve(),
    ping: () => Promise.resolve(),
  };
  started = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [ALLOWED_ORIGIN],
      internalOidc: OIDC_CONFIG,
    },
    storage,
    { flushLogs: () => Promise.resolve() }
  );
  await started.server.listen();
  return { server: started.server, port: started.server.address.port };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const provider of providers.splice(0)) {
    provider.configuration.websocketProvider.destroy();
    provider.destroy();
  }
  await started?.shutdown();
  started = undefined;
});

/** Connects with `token` and resolves with the authentication outcome. */
function connect(
  port: number,
  token: string
): { provider: HocuspocusProvider; outcome: Promise<AuthOutcome> } {
  let settle: (outcome: AuthOutcome) => void = () => undefined;
  const outcome = new Promise<AuthOutcome>((resolve) => {
    settle = resolve;
  });
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: DOCUMENT_NAME,
    token,
    onAuthenticated: () => settle({ authenticated: true }),
    onAuthenticationFailed: ({ reason }) =>
      settle({ authenticated: false, reason }),
  });
  providers.push(provider);
  return { provider, outcome };
}

async function connectSynced(
  port: number,
  access: GrantAccess
): Promise<HocuspocusProvider> {
  const { provider, outcome } = connect(port, await documentToken(access));
  const { authenticated, reason } = await outcome;
  if (!authenticated) {
    throw new Error(`authentication failed: ${reason}`);
  }
  await waitFor(() => provider.isSynced, "the provider's first sync");
  return provider;
}

function text(provider: HocuspocusProvider): string {
  return provider.document.getText(TEXT).toString();
}

/** Resolves once the server answers one of `provider`'s updates as not applied. */
function nextRefusedUpdate(provider: HocuspocusProvider): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = ({ message }: onMessageParameters) => {
      message.readVarString();
      if (
        message.readVarUint() === MessageType.SyncStatus &&
        message.readVarUint() === NOT_APPLIED
      ) {
        provider.off("message", onMessage);
        resolve();
      }
    };
    provider.on("message", onMessage);
  });
}

/** The status a WebSocket upgrade with these headers is answered with. */
function upgradeStatus(
  port: number,
  headers: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("doc-sync token authentication through Hocuspocus", () => {
  it("syncs edits between two clients holding write grants", async () => {
    const { port } = await start();
    const first = await connectSynced(port, GrantAccess.Write);
    const second = await connectSynced(port, GrantAccess.Write);

    first.document.getText(TEXT).insert(0, "from first");
    await waitFor(
      () => text(second) === "from first",
      "the second client to see the first's edit"
    );
    second.document.getText(TEXT).insert(0, "second, ");

    await waitFor(
      () => text(first) === "second, from first",
      "the first client to see the second's edit"
    );
  });

  it("drops a read-only client's edit before it reaches the document or another client", async () => {
    const { server, port } = await start();
    const writer = await connectSynced(port, GrantAccess.Write);
    const reader = await connectSynced(port, GrantAccess.Read);
    expect(reader.authorizedScope).toBe("readonly");
    expect(writer.authorizedScope).toBe("read-write");

    const refused = nextRefusedUpdate(reader);
    reader.document.getText(TEXT).insert(0, "from the reader");
    await refused;
    writer.document.getText(TEXT).insert(0, "from the writer");
    await waitFor(
      () => text(reader).includes("from the writer"),
      "the reader to receive the writer's later edit"
    );

    const serverDocument = server.hocuspocus.documents.get(DOCUMENT_NAME);
    expect(serverDocument?.getText(TEXT).toString()).toBe("from the writer");
    expect(text(writer)).toBe("from the writer");
  });

  it("refuses an expired token with token_expired", async () => {
    const { port } = await start();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 2 * REALTIME_TOKEN_TTL_SECONDS * 1000);
    const token = await documentToken(GrantAccess.Write);
    vi.useRealTimers();

    await expect(connect(port, token).outcome).resolves.toEqual({
      authenticated: false,
      reason: RealtimeErrorCode.TokenExpired,
    });
  });

  it("refuses an upgrade from a browser origin outside the allow-list", async () => {
    const { port } = await start();

    await expect(
      upgradeStatus(port, { Origin: "https://evil.example" })
    ).resolves.toBe(HTTP_FORBIDDEN);
  });

  it("admits an upgrade from an allowed origin, and one with no Origin", async () => {
    const { port } = await start();

    await expect(upgradeStatus(port, { Origin: ALLOWED_ORIGIN })).resolves.toBe(
      HTTP_SWITCHING_PROTOCOLS
    );
    await expect(upgradeStatus(port, {})).resolves.toBe(
      HTTP_SWITCHING_PROTOCOLS
    );
  });
});
