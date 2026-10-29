import { connect as netConnect } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { HttpServiceErrorCode } from "@repo/http-service/errors";
import {
  createInternalOidcVerifier,
  type InternalOidcVerifier,
} from "@repo/http-service/internal-oidc";
import {
  createOidcFixture,
  OIDC_CONFIG,
  type OidcFixture,
} from "@repo/http-service/test-support/oidc-fixture";
import { log } from "@repo/observability/log";
import {
  DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
  DocSyncDocumentCommand,
  DocSyncInternalErrorCode,
  docSyncDocumentPath,
  FirstOpenSeedState,
} from "@repo/realtime-contract/doc-sync-internal";
import {
  generateDocumentRoomId,
  RoomNamespace,
} from "@repo/realtime-contract/document-room";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DOC_SYNC_COMMAND_COMPLETED_EVENT } from "../commands/command-timer";
import type { DocSyncCommands } from "../commands/document-commands";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import { MAX_INTERNAL_BODY_BYTES } from "../http/internal-routes";
import {
  createDocSyncServer,
  DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
} from "../server";
import type { DocumentStorage } from "../storage/document-storage";
import { PUBLIC_KEYS } from "./auth/test-tokens";
import { waitFor } from "./integration/test-schema";
import { appendParagraph, documentState } from "./support/documents";
import { memoryStorage } from "./support/memory-storage";

const ORG = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const NAME = generateDocumentRoomId(ORG, "PLN-1");
const NON_CANONICAL = `${ORG}:${RoomNamespace.Document}:PLN-1`;
const ANCHOR_TEXT = "repeated anchor phrase";
const UNSAVED_TEXT = "an unsaved provider edit";
const FIRST_OPEN_SEED_BODY = JSON.stringify({ markdown: "# Plan", version: 1 });

type Started = {
  port: number;
  commands: DocSyncCommands;
  storage: DocumentStorage;
  shutdown: () => Promise<void>;
};

let fixture: OidcFixture;
let started: Started | undefined;
const providers: HocuspocusProvider[] = [];

beforeAll(async () => {
  fixture = await createOidcFixture();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const provider of providers.splice(0)) {
    provider.configuration.websocketProvider.destroy();
    provider.destroy();
  }
  await started?.shutdown();
  started = undefined;
});

async function start(seed: [string, Uint8Array][] = []): Promise<Started> {
  const { storage } = memoryStorage(seed);
  const verifyInternalOidc: InternalOidcVerifier = createInternalOidcVerifier(
    OIDC_CONFIG,
    {
      unavailableEvent: DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
      fetch: fixture.servingJwks(),
    }
  );
  const { server, shutdown, commands } = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
    },
    storage,
    {
      onAuthenticate: () => Promise.resolve(),
      verifyInternalOidc,
      flushLogs: () => Promise.resolve(),
    }
  );
  await server.listen();
  started = { port: server.address.port, commands, storage, shutdown };
  return started;
}

function pathOf(name: string, command?: DocSyncDocumentCommand): string {
  const path = docSyncDocumentPath(name, command);
  if (path === undefined) {
    throw new Error(`${name} is not addressable`);
  }
  return path;
}

async function call(
  port: number,
  method: string,
  path: string,
  {
    body,
    contentType = "application/json",
    token,
  }: { body?: string; contentType?: string; token?: string | null } = {}
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": contentType };
  const bearer = token === undefined ? await fixture.mint() : token;
  if (bearer !== null) {
    headers.authorization = `Bearer ${bearer}`;
  }
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
}

function anchorBody(anchorText: string): string {
  return JSON.stringify({ threadId: "th_1", anchorText });
}

/** Every captured log call, serialized, so a test can assert what never reached a log. */
function spyOnLogs(): () => string {
  const spies = [
    vi.spyOn(log, "info").mockImplementation(() => undefined),
    vi.spyOn(log, "warn").mockImplementation(() => undefined),
    vi.spyOn(log, "error").mockImplementation(() => undefined),
  ];
  return () => JSON.stringify(spies.map((spy) => spy.mock.calls));
}

type RawResponse = { status: number; head: string; body: string };

/** Sends `requestLine` as written, so no client normalizes the target first. */
function rawRequest(
  port: number,
  requestLine: string,
  token: string
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const [head = "", body = ""] = received.split("\r\n\r\n");
      resolve({ status: Number(head.split(" ")[1]), head, body });
    });
    socket.write(
      `${requestLine} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
    );
  });
}

const ROUTES: [method: string, path: string][] = [
  ["GET", DOC_SYNC_INTERNAL_DOCUMENTS_PATH],
  ["POST", pathOf(NAME, DocSyncDocumentCommand.Clear)],
  ["POST", pathOf(NAME, DocSyncDocumentCommand.CommentAnchors)],
  ["GET", pathOf(NAME, DocSyncDocumentCommand.Text)],
  ["GET", pathOf(NAME, DocSyncDocumentCommand.FirstOpenSeed)],
  ["POST", pathOf(NAME, DocSyncDocumentCommand.SeedIfNeverStored)],
  ["DELETE", pathOf(NAME)],
];

const DOCUMENT_ROUTES: [method: string, path: string, body?: string][] = [
  ["POST", pathOf(NON_CANONICAL, DocSyncDocumentCommand.Clear)],
  [
    "POST",
    pathOf(NON_CANONICAL, DocSyncDocumentCommand.CommentAnchors),
    anchorBody(ANCHOR_TEXT),
  ],
  ["GET", pathOf(NON_CANONICAL, DocSyncDocumentCommand.Text)],
  ["GET", pathOf(NON_CANONICAL, DocSyncDocumentCommand.FirstOpenSeed)],
  [
    "POST",
    pathOf(NON_CANONICAL, DocSyncDocumentCommand.SeedIfNeverStored),
    FIRST_OPEN_SEED_BODY,
  ],
  ["DELETE", pathOf(NON_CANONICAL)],
];

describe("/internal/documents routes", () => {
  it.each(ROUTES)("refuses %s %s with no bearer 401", async (method, path) => {
    const { port } = await start();

    const response = await call(port, method, path, { token: null });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: RealtimeErrorCode.Unauthorized,
    });
  });

  it.each(DOCUMENT_ROUTES)(
    "refuses %s %s, a non-canonical name, 400",
    async (method, path, body) => {
      const { port } = await start();

      const response = await call(port, method, path, { body });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: DocSyncInternalErrorCode.InvalidDocumentName,
      });
    }
  );

  it("refuses a percent-encoded name 400 rather than running the command on its decoded form", async () => {
    const { port, commands } = await start();
    const clear = vi.spyOn(commands, "clear");

    const response = await call(
      port,
      "POST",
      `${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/${ORG}:artifact:%50LN-1/${DocSyncDocumentCommand.Clear}`
    );

    expect(response.status).toBe(400);
    expect(clear).not.toHaveBeenCalled();
  });

  it.each([
    ["a schema miss", JSON.stringify({ threadId: "", anchorText: "x" })],
    [
      "an unknown field",
      JSON.stringify({ threadId: "t", anchorText: "x", y: 1 }),
    ],
    ["a body that is not JSON", "{"],
  ])("refuses comment-anchors with %s 400", async (_case, body) => {
    const { port } = await start();

    const response = await call(
      port,
      "POST",
      pathOf(NAME, DocSyncDocumentCommand.CommentAnchors),
      { body }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: HttpServiceErrorCode.InvalidBody,
    });
  });

  it.each([
    pathOf(NAME, DocSyncDocumentCommand.CommentAnchors),
    pathOf(NAME, DocSyncDocumentCommand.Clear),
  ])("refuses a body one byte over the cap on POST %s 413", async (path) => {
    const { port } = await start();

    const response = await call(port, "POST", path, {
      body: "x".repeat(MAX_INTERNAL_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: RealtimeErrorCode.PayloadTooLarge,
    });
  });

  it("clears a never-stored document without loading or storing it", async () => {
    const { port, storage } = await start();

    const response = await call(
      port,
      "POST",
      pathOf(NAME, DocSyncDocumentCommand.Clear)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cleared: false });
    expect(storage.store).not.toHaveBeenCalled();
  });

  it("reads a loaded document's text, unsaved edits included, without storing it", async () => {
    const { port, storage } = await start();
    const logged = spyOnLogs();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}`,
      name: NAME,
      token: "any-token",
    });
    providers.push(provider);
    await waitFor(() => provider.isSynced, "the provider's first sync");
    appendParagraph(provider.document, UNSAVED_TEXT);
    await waitFor(
      () => !provider.hasUnsyncedChanges,
      "the server to acknowledge the edit"
    );

    const response = await call(
      port,
      "GET",
      pathOf(NAME, DocSyncDocumentCommand.Text)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: UNSAVED_TEXT });
    // Still inside the 2 s store debounce, and reading opened no direct connection.
    expect(storage.store).not.toHaveBeenCalled();
    expect(logged()).not.toContain(UNSAVED_TEXT);
  });

  it("clears a stored document's content and stores the cleared state", async () => {
    const { port, storage } = await start([
      [NAME, documentState("to be cleared")],
    ]);

    const cleared = await call(
      port,
      "POST",
      pathOf(NAME, DocSyncDocumentCommand.Clear)
    );
    const text = await call(
      port,
      "GET",
      pathOf(NAME, DocSyncDocumentCommand.Text)
    );

    expect(await cleared.json()).toEqual({ cleared: true });
    expect(await text.json()).toEqual({ text: "" });
    expect(storage.store).toHaveBeenCalled();
  });

  it("reads a stored document's text without loading it", async () => {
    const { port } = await start([
      [NAME, documentState("first block", "second block")],
    ]);

    const response = await call(
      port,
      "GET",
      pathOf(NAME, DocSyncDocumentCommand.Text)
    );

    expect(await response.json()).toEqual({
      text: "first block\nsecond block",
    });
  });

  it("refuses an anchor on a never-stored document 422 anchor_not_found", async () => {
    const { port, storage } = await start();

    const response = await call(
      port,
      "POST",
      pathOf(NAME, DocSyncDocumentCommand.CommentAnchors),
      { body: anchorBody(ANCHOR_TEXT) }
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: DocSyncInternalErrorCode.AnchorNotFound,
      matchCount: 0,
    });
    expect(storage.store).not.toHaveBeenCalled();
  });

  it("answers a never-stored document's text 404", async () => {
    const { port } = await start();

    const response = await call(
      port,
      "GET",
      pathOf(NAME, DocSyncDocumentCommand.Text)
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: HttpServiceErrorCode.NotFound,
    });
  });

  it("refuses an ambiguous anchor 422 with the match count, and logs no anchor text", async () => {
    const { port } = await start([
      [NAME, documentState(`${ANCHOR_TEXT} and`, `again ${ANCHOR_TEXT}`)],
    ]);
    const logged = spyOnLogs();

    const response = await call(
      port,
      "POST",
      pathOf(NAME, DocSyncDocumentCommand.CommentAnchors),
      { body: anchorBody(ANCHOR_TEXT) }
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: DocSyncInternalErrorCode.AnchorAmbiguous,
      matchCount: 2,
    });
    expect(logged()).toContain(DOC_SYNC_COMMAND_COMPLETED_EVENT);
    expect(logged()).not.toContain(ANCHOR_TEXT);
  });

  it("answers every command on a deleted document 410", async () => {
    const { port } = await start();
    const deleted = await call(port, "DELETE", pathOf(NAME));
    expect(await deleted.json()).toEqual({ deleted: false, wasLoaded: false });

    const responses = await Promise.all([
      call(port, "POST", pathOf(NAME, DocSyncDocumentCommand.Clear)),
      call(port, "POST", pathOf(NAME, DocSyncDocumentCommand.CommentAnchors), {
        body: anchorBody(ANCHOR_TEXT),
      }),
      call(port, "GET", pathOf(NAME, DocSyncDocumentCommand.Text)),
      call(port, "GET", pathOf(NAME, DocSyncDocumentCommand.FirstOpenSeed)),
      call(
        port,
        "POST",
        pathOf(NAME, DocSyncDocumentCommand.SeedIfNeverStored),
        { body: FIRST_OPEN_SEED_BODY }
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        code: DocSyncInternalErrorCode.DocumentDeleted,
      });
    }
  });

  it("probes and applies a first-open seed, then probes the stored document", async () => {
    const { port, storage } = await start();
    const probe = () =>
      call(port, "GET", pathOf(NAME, DocSyncDocumentCommand.FirstOpenSeed));

    const before = await probe();
    const applied = await call(
      port,
      "POST",
      pathOf(NAME, DocSyncDocumentCommand.SeedIfNeverStored),
      { body: FIRST_OPEN_SEED_BODY }
    );
    const after = await probe();

    expect(before.status).toBe(200);
    expect(before.headers.get("cache-control")).toBe("no-store");
    expect(await before.json()).toEqual({
      state: FirstOpenSeedState.NeedsSeed,
    });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({
      applied: true,
      updateBytes: expect.any(Number),
    });
    await expect(storage.exists(NAME)).resolves.toBe(true);
    expect(await after.json()).toEqual({ state: FirstOpenSeedState.Stored });
  });

  describe("path-normalization probes", () => {
    const clearPath = pathOf(NAME, DocSyncDocumentCommand.Clear);

    it.each([
      `POST /health/..${clearPath}`,
      `POST ${clearPath.replace("/documents/", "/%64ocuments/")}`,
      `POST http://evil${clearPath}`,
    ])("answers %s an empty 404, never reaching clear", async (requestLine) => {
      const { port, commands } = await start();
      const clear = vi.spyOn(commands, "clear");

      const response = await rawRequest(
        port,
        requestLine,
        await fixture.mint()
      );

      expect(response.status).toBe(404);
      expect(response.body).toBe("");
      expect(clear).not.toHaveBeenCalled();
    });

    it("reaches clear through the plain path with the same bearer", async () => {
      const { port, commands } = await start();
      const clear = vi.spyOn(commands, "clear");

      const response = await rawRequest(
        port,
        `POST ${clearPath}`,
        await fixture.mint()
      );

      expect(response.status).toBe(200);
      expect(clear).toHaveBeenCalledOnce();
    });
  });
});
