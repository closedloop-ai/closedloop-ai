import { HocuspocusProvider } from "@hocuspocus/provider";
import { HttpServiceErrorCode } from "@repo/http-service/errors";
import { createInternalOidcVerifier } from "@repo/http-service/internal-oidc";
import {
  createOidcFixture,
  OIDC_CONFIG,
  type OidcFixture,
} from "@repo/http-service/test-support/oidc-fixture";
import { log } from "@repo/observability/log";
import {
  DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
  DOC_SYNC_REVOKE_PATH,
  DocSyncDocumentCommand,
  DocSyncInternalErrorCode,
  docSyncDocumentPath,
} from "@repo/realtime-contract/doc-sync-internal";
import {
  generateDocumentRoomId,
  RoomNamespace,
} from "@repo/realtime-contract/document-room";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { DocSyncCommands } from "../commands/document-commands";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import {
  createDocSyncServer,
  DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
} from "../server";
import { PUBLIC_KEYS } from "./auth/test-tokens";
import { waitFor } from "./integration/test-schema";
import { memoryStorage } from "./support/memory-storage";

const ORG = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const NAME = generateDocumentRoomId(ORG, "PLN-1");
const USER_ID = "user-1";
const WAIT_MS = 5000;

let fixture: OidcFixture;
let port = 0;
let commands: DocSyncCommands;
let shutdown: (() => Promise<void>) | undefined;
const providers: HocuspocusProvider[] = [];

beforeAll(async () => {
  fixture = await createOidcFixture();
});

beforeEach(async () => {
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  const started = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
    },
    memoryStorage().storage,
    {
      onAuthenticate: () =>
        Promise.resolve({
          userId: USER_ID,
          orgId: ORG,
          tokenIssuedAt: Math.floor(Date.now() / 1000),
        }),
      verifyInternalOidc: createInternalOidcVerifier(OIDC_CONFIG, {
        unavailableEvent: DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
        fetch: fixture.servingJwks(),
      }),
      flushLogs: () => Promise.resolve(),
    }
  );
  await started.server.listen();
  port = started.server.address.port;
  commands = started.commands;
  shutdown = started.shutdown;
});

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    provider.configuration.websocketProvider.destroy();
    provider.destroy();
  }
  await shutdown?.();
  shutdown = undefined;
  vi.restoreAllMocks();
});

function disconnectPath(name: string): string {
  const path = docSyncDocumentPath(name, DocSyncDocumentCommand.Disconnect);
  if (path === undefined) {
    throw new Error(`${name} is not addressable`);
  }
  return path;
}

async function post(
  path: string,
  { body, bearer = true }: { body?: string; bearer?: boolean } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (bearer) {
    headers.authorization = `Bearer ${await fixture.mint()}`;
  }
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body,
  });
}

async function errorCode(response: Response): Promise<unknown> {
  return ((await response.json()) as { code?: unknown }).code;
}

describe("POST /internal/revoke", () => {
  const VALID = JSON.stringify({ target: { userId: USER_ID } });

  it("refuses a request with no bearer, 401", async () => {
    const response = await post(DOC_SYNC_REVOKE_PATH, {
      body: VALID,
      bearer: false,
    });

    expect(response.status).toBe(401);
  });

  it.each([
    ["a target with two keys", { target: { userId: USER_ID, orgId: ORG } }],
    ["an org id no channel can name", { target: { orgId: "Not An Org" } }],
  ])("refuses %s, 400", async (_label, body) => {
    const response = await post(DOC_SYNC_REVOKE_PATH, {
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(HttpServiceErrorCode.InvalidBody);
  });

  it("takes a body of exactly 16 KiB, and refuses one byte more, 413", async () => {
    // A literal bound: a test reading the constant could not catch a changed cap.
    const ofLength = (bytes: number) => {
      const envelope = JSON.stringify({ target: { userId: "" } }).length;
      return JSON.stringify({
        target: { userId: "u".repeat(bytes - envelope) },
      });
    };

    const atCap = await post(DOC_SYNC_REVOKE_PATH, {
      body: ofLength(16 * 1024),
    });
    const overCap = await post(DOC_SYNC_REVOKE_PATH, {
      body: ofLength(16 * 1024 + 1),
    });

    expect(atCap.status).toBe(200);
    expect(overCap.status).toBe(413);
  });

  it("closes the target's connection, 200 with the count", async () => {
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}`,
      name: NAME,
      token: "any-token",
    });
    providers.push(provider);
    await waitFor(() => provider.isAuthenticated, "authenticated", WAIT_MS);

    const response = await post(DOC_SYNC_REVOKE_PATH, { body: VALID });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ closedConnections: 1 });
  });
});

describe("POST /internal/documents/:documentName/disconnect", () => {
  it("refuses a name that is not a canonical room id, 400", async () => {
    const response = await post(
      `${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/${ORG}:${RoomNamespace.Document}:PLN-1/${DocSyncDocumentCommand.Disconnect}`
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(
      DocSyncInternalErrorCode.InvalidDocumentName
    );
  });

  it("answers a deleted document 200 with nothing closed", async () => {
    await commands.deleteDocument(NAME);

    const response = await post(disconnectPath(NAME));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closedConnections: 0 });
  });
});
