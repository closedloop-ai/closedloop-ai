import { ResetConnection } from "@hocuspocus/common";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Server } from "@hocuspocus/server";
import { createInternalOidcVerifier } from "@repo/http-service/internal-oidc";
import {
  createOidcFixture,
  OIDC_CONFIG,
  type OidcFixture,
} from "@repo/http-service/test-support/oidc-fixture";
import {
  DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
  DocSyncDocumentCommand,
  DocSyncInternalErrorCode,
  docSyncDocumentPath,
} from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { GrantAccess } from "@repo/realtime-contract/grants";
import type pg from "pg";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { authorizeConnection } from "../auth/authorize";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import {
  createDocSyncServer,
  DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
} from "../server";
import {
  loadDocumentState,
  saveDocumentState,
} from "../storage/document-state";
import {
  type DocumentStorage,
  pgDocumentStorage,
} from "../storage/document-storage";
import { MIGRATIONS_DIR, runMigrations } from "../storage/migrate";
import {
  DOCUMENT_NAME,
  documentToken,
  ORG,
  PUBLIC_KEYS,
} from "./auth/test-tokens";
import { integrationPg } from "./integration/integration-env";
import {
  createTestSchema,
  type TestSchema,
  waitFor,
} from "./integration/test-schema";
import { appendParagraph, documentState } from "./support/documents";

const UNLOAD_DEADLINE_MS = 200;
const AUTH_TIMEOUT_MS = 5000;

/** While `hold` is set, the real token verify waits on `release` after calling `started`. */
const authorizeGate = vi.hoisted(
  (): { hold?: { started: () => void; release: Promise<void> } } => ({})
);

vi.mock("../auth/authorize", async (importOriginal) => {
  const actual: { authorizeConnection: typeof authorizeConnection } =
    await importOriginal();
  return {
    ...actual,
    authorizeConnection: async (
      ...args: Parameters<typeof authorizeConnection>
    ) => {
      const hold = authorizeGate.hold;
      if (hold) {
        hold.started();
        await hold.release;
      }
      return actual.authorizeConnection(...args);
    },
  };
});

type Started = { server: Server; port: number; shutdown: () => Promise<void> };

let schema: TestSchema | undefined;
let fixture: OidcFixture;
const servers: Started[] = [];
const providers: HocuspocusProvider[] = [];

/** Real token authentication, so a deleted document's refusal is the production one. */
async function startServer(storage: DocumentStorage): Promise<Started> {
  const { server, shutdown } = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
    },
    storage,
    {
      verifyInternalOidc: createInternalOidcVerifier(OIDC_CONFIG, {
        unavailableEvent: DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
        fetch: fixture.servingJwks(),
      }),
      deleteUnloadDeadlineMs: UNLOAD_DEADLINE_MS,
      flushLogs: () => Promise.resolve(),
    }
  );
  await server.listen();
  const started = { server, port: server.address.port, shutdown };
  servers.push(started);
  return started;
}

type Connected = {
  provider: HocuspocusProvider;
  closeReasons: string[];
  authentication: Promise<{ authenticated: boolean; reason?: string }>;
};

function connect(port: number, token: string): Connected {
  const closeReasons: string[] = [];
  let settle: (outcome: { authenticated: boolean; reason?: string }) => void =
    () => undefined;
  const authentication = new Promise<{
    authenticated: boolean;
    reason?: string;
  }>((resolve, reject) => {
    settle = resolve;
    setTimeout(
      () => reject(new Error("no authentication outcome")),
      AUTH_TIMEOUT_MS
    ).unref();
  });
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: DOCUMENT_NAME,
    token,
    onAuthenticated: () => settle({ authenticated: true }),
    onAuthenticationFailed: ({ reason }) =>
      settle({ authenticated: false, reason }),
    onClose: ({ event }) => {
      closeReasons.push(event.reason);
    },
  });
  providers.push(provider);
  return { provider, closeReasons, authentication };
}

async function editAndSync(
  provider: HocuspocusProvider,
  text: string
): Promise<void> {
  await waitFor(() => provider.isSynced, "the provider's first sync");
  appendParagraph(provider.document, text);
  await waitFor(
    () => !provider.hasUnsyncedChanges,
    "the server to acknowledge the edit"
  );
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
  path: string
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${await fixture.mint()}` },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  fixture = await createOidcFixture();
});

describe.skipIf(!integrationPg)("the delete command", () => {
  beforeEach(async () => {
    if (!integrationPg) {
      return;
    }
    schema = await createTestSchema(integrationPg);
    await runMigrations(schema.connect(), MIGRATIONS_DIR);
  });

  afterEach(async () => {
    authorizeGate.hold = undefined;
    for (const provider of providers.splice(0)) {
      provider.configuration.websocketProvider.destroy();
      provider.destroy();
    }
    await Promise.all(servers.splice(0).map((started) => started.shutdown()));
    await schema?.drop();
    schema = undefined;
  });

  function testPool(): pg.Pool {
    if (!schema) {
      throw new Error("no schema");
    }
    return schema.connect();
  }

  it("a deleted document does not come back", async () => {
    const pool = testPool();
    const { server, port, shutdown } = await startServer(
      pgDocumentStorage(testPool())
    );
    const token = await documentToken(GrantAccess.Write);
    const editor = connect(port, token);
    await editor.authentication;
    await editAndSync(editor.provider, "stored before the delete");
    await waitFor(
      async () => (await loadDocumentState(pool, DOCUMENT_NAME)) !== null,
      "the first edit to be stored"
    );
    // Inside the 2 s debounce: this edit is pending when the delete arrives.
    await editAndSync(editor.provider, "pending at the delete");

    const response = await call(port, "DELETE", pathOf(DOCUMENT_NAME));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, wasLoaded: true });
    await waitFor(
      () => editor.closeReasons.includes(ResetConnection.reason),
      "the editor to be closed with Reset Connection"
    );
    expect(server.hocuspocus.documents.has(DOCUMENT_NAME)).toBe(false);
    expect(server.hocuspocus.getConnectionsCount()).toBe(0);

    const latecomer = connect(port, token);
    await expect(latecomer.authentication).resolves.toEqual({
      authenticated: false,
      reason: RealtimeErrorCode.Unauthorized,
    });
    expect(server.hocuspocus.documents.has(DOCUMENT_NAME)).toBe(false);
    expect(server.hocuspocus.loadingDocuments.has(DOCUMENT_NAME)).toBe(false);

    await shutdown();

    await expect(loadDocumentState(pool, DOCUMENT_NAME)).resolves.toBeNull();
  });

  it("refuses a connection whose token check is pending when the delete lands, and the row stays gone", async () => {
    const pool = testPool();
    await saveDocumentState(pool, DOCUMENT_NAME, documentState("deleted"));
    const { server, port, shutdown } = await startServer(
      pgDocumentStorage(testPool())
    );
    const verifying = deferred();
    const release = deferred();
    authorizeGate.hold = {
      started: verifying.resolve,
      release: release.promise,
    };
    const latecomer = connect(port, await documentToken(GrantAccess.Write));
    await verifying.promise;

    const response = await call(port, "DELETE", pathOf(DOCUMENT_NAME));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, wasLoaded: false });
    release.resolve();
    await expect(latecomer.authentication).resolves.toEqual({
      authenticated: false,
      reason: RealtimeErrorCode.Unauthorized,
    });
    expect(server.hocuspocus.documents.has(DOCUMENT_NAME)).toBe(false);
    expect(server.hocuspocus.loadingDocuments.has(DOCUMENT_NAME)).toBe(false);
    await shutdown();

    await expect(loadDocumentState(pool, DOCUMENT_NAME)).resolves.toBeNull();
  });

  it("waits for a store that is executing when the delete arrives", async () => {
    const pool = testPool();
    const real = pgDocumentStorage(testPool());
    const gate = deferred();
    const storeStarted = deferred();
    const { server, port, shutdown } = await startServer({
      ...real,
      store: async (name, state) => {
        storeStarted.resolve();
        await gate.promise;
        return real.store(name, state);
      },
    });
    const editor = connect(port, await documentToken(GrantAccess.Write));
    await editor.authentication;
    await editAndSync(editor.provider, "held in a blocked store");
    await storeStarted.promise;

    let settled = false;
    const deleting = call(port, "DELETE", pathOf(DOCUMENT_NAME)).then(
      (response) => {
        settled = true;
        return response;
      }
    );
    await waitFor(
      () => server.hocuspocus.getConnectionsCount() === 0,
      "the delete to close the editor"
    );
    expect(settled).toBe(false);
    gate.resolve();

    const response = await deleting;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, wasLoaded: true });
    await shutdown();
    await expect(loadDocumentState(pool, DOCUMENT_NAME)).resolves.toBeNull();
  });

  it("unloads and deletes a document whose stores fail forever", async () => {
    const pool = testPool();
    const real = pgDocumentStorage(testPool());
    let failing = false;
    let failedStores = 0;
    const { server, port, shutdown } = await startServer({
      ...real,
      store: (name, state) => {
        if (!failing) {
          return real.store(name, state);
        }
        failedStores += 1;
        return Promise.reject(new Error("store unavailable"));
      },
    });
    const editor = connect(port, await documentToken(GrantAccess.Write));
    await editor.authentication;
    await editAndSync(editor.provider, "stored once");
    await waitFor(
      async () => (await loadDocumentState(pool, DOCUMENT_NAME)) !== null,
      "the first edit to be stored"
    );
    failing = true;
    await editAndSync(editor.provider, "never stored");
    await waitFor(() => failedStores > 0, "a store to fail");

    const response = await call(port, "DELETE", pathOf(DOCUMENT_NAME));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, wasLoaded: true });
    expect(server.hocuspocus.documents.has(DOCUMENT_NAME)).toBe(false);
    await shutdown();
    await expect(loadDocumentState(pool, DOCUMENT_NAME)).resolves.toBeNull();
  });

  it("answers clear on a deleted document 410", async () => {
    const { port } = await startServer(pgDocumentStorage(testPool()));
    await call(port, "DELETE", pathOf(DOCUMENT_NAME));

    const response = await call(
      port,
      "POST",
      pathOf(DOCUMENT_NAME, DocSyncDocumentCommand.Clear)
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      code: DocSyncInternalErrorCode.DocumentDeleted,
    });
  });

  it("lists stored names across two pages", async () => {
    const pool = testPool();
    const names = ["PLN-1", "PLN-2", "PLN-3"].map((slug) =>
      generateDocumentRoomId(ORG, slug)
    );
    for (const name of names) {
      await saveDocumentState(pool, name, documentState(name));
    }
    const { port } = await startServer(pgDocumentStorage(testPool()));

    const first = await call(
      port,
      "GET",
      `${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}?limit=2`
    );
    const firstPage = await first.json();
    const second = await call(
      port,
      "GET",
      `${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}?limit=2&after=${encodeURIComponent(firstPage.nextAfter)}`
    );

    expect(firstPage).toEqual({
      names: names.slice(0, 2),
      nextAfter: names[1],
    });
    expect(await second.json()).toEqual({
      names: names.slice(2),
      nextAfter: null,
    });
  });

  it("answers 503 unload_timeout while an open direct connection holds the document, and keeps the row", async () => {
    const pool = testPool();
    await saveDocumentState(pool, DOCUMENT_NAME, documentState("held open"));
    const { server, port } = await startServer(pgDocumentStorage(testPool()));
    const holder = await server.hocuspocus.openDirectConnection(DOCUMENT_NAME);

    const response = await call(port, "DELETE", pathOf(DOCUMENT_NAME));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: DocSyncInternalErrorCode.UnloadTimeout,
    });
    await expect(
      loadDocumentState(pool, DOCUMENT_NAME)
    ).resolves.not.toBeNull();
    await holder.disconnect();
  });
});
