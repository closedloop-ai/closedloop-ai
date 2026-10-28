import type { Socket } from "node:net";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import type { Document, Server } from "@hocuspocus/server";
import { OIDC_CONFIG } from "@repo/http-service/test-support/oidc-fixture";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyUpdate, Doc } from "yjs";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import { createDocSyncServer } from "../server";
import { loadDocumentState } from "../storage/document-state";
import {
  type DocumentStorage,
  pgDocumentStorage,
} from "../storage/document-storage";
import { MIGRATIONS_DIR, runMigrations } from "../storage/migrate";
import { PUBLIC_KEYS } from "./auth/test-tokens";
import { integrationPg } from "./integration/integration-env";
import {
  createTestSchema,
  type TestSchema,
  waitFor,
} from "./integration/test-schema";

const DOCUMENT = "org-1:PRD-1";
const TEXT = "content";
const RECONNECT_DELAY_MS = 100;
/** The store on the last editor's disconnect, then two retries. */
const FAILED_STORES = 3;

type Started = {
  server: Server;
  shutdown: () => Promise<void>;
  port: number;
  /** A hard kill: every TCP socket dies at once, and nothing is destroyed or flushed. */
  kill: () => void;
};

let schema: TestSchema | undefined;
const servers: Started[] = [];
const sockets: HocuspocusProviderWebsocket[] = [];
const providers: HocuspocusProvider[] = [];

/** Token auth has its own suite (auth.integration.test.ts); this one admits every provider. */
async function startServer(
  storage: DocumentStorage,
  port = 0
): Promise<Started> {
  const { server, shutdown } = createDocSyncServer(
    {
      port,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
    },
    storage,
    {
      onAuthenticate: () => Promise.resolve(),
      flushLogs: () => Promise.resolve(),
    }
  );
  const open = new Set<Socket>();
  server.httpServer.on("connection", (socket: Socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await server.listen();
  const started: Started = {
    server,
    shutdown,
    port: server.address.port,
    kill: () => {
      server.httpServer.close();
      for (const socket of open) {
        socket.destroy();
      }
    },
  };
  servers.push(started);
  return started;
}

/** A provider that retries quickly, so a reconnect lands within the test's wait. */
function connect(port: number): HocuspocusProvider {
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}`,
    delay: RECONNECT_DELAY_MS,
    minDelay: RECONNECT_DELAY_MS,
    maxDelay: RECONNECT_DELAY_MS,
    factor: 1,
    jitter: false,
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: DOCUMENT,
    token: "any-token",
  });
  provider.attach();
  sockets.push(socket);
  providers.push(provider);
  return provider;
}

type FlakyStorage = {
  failing: boolean;
  /** Set once the server is up, so a store can see which document is loaded. */
  server?: Server;
  loadedAtStore: (Document | undefined)[];
  storage: DocumentStorage;
};

/**
 * A Postgres storage whose stores fail while `failing` holds, recording which
 * loaded document each store call saw.
 */
function flakyStorage(pool: pg.Pool): FlakyStorage {
  const real = pgDocumentStorage(pool);
  const flaky: FlakyStorage = {
    failing: true,
    loadedAtStore: [],
    storage: real,
  };
  flaky.storage = {
    ...real,
    store: (documentName, state) => {
      flaky.loadedAtStore.push(
        flaky.server?.hocuspocus.documents.get(documentName)
      );
      return flaky.failing
        ? Promise.reject(new Error("store unavailable"))
        : real.store(documentName, state);
    },
  };
  return flaky;
}

/** Closes the editor's only connection, leaving the document no connections. */
function disconnect(provider: HocuspocusProvider): void {
  provider.destroy();
  provider.configuration.websocketProvider.destroy();
}

function storedText(state: Uint8Array | null): string {
  const doc = new Doc();
  if (state) {
    applyUpdate(doc, state);
  }
  return doc.getText(TEXT).toString();
}

/** Edits, then waits until the server has acknowledged the edit. */
async function editAndSync(
  provider: HocuspocusProvider,
  text: string
): Promise<void> {
  await waitFor(() => provider.isSynced, "the provider's first sync");
  provider.document.getText(TEXT).insert(0, text);
  await waitFor(
    () => !provider.hasUnsyncedChanges,
    "the server to acknowledge the edit"
  );
}

describe.skipIf(!integrationPg)(
  "doc-sync persistence through Hocuspocus",
  () => {
    beforeEach(async () => {
      if (!integrationPg) {
        return;
      }
      schema = await createTestSchema(integrationPg);
      await runMigrations(schema.connect(), MIGRATIONS_DIR);
    });

    afterEach(async () => {
      for (const provider of providers.splice(0)) {
        provider.destroy();
      }
      for (const socket of sockets.splice(0)) {
        socket.destroy();
      }
      await Promise.all(servers.splice(0).map((started) => started.shutdown()));
      await schema?.drop();
      schema = undefined;
    });

    it("persists an edit still inside the store debounce when the service shuts down", async () => {
      if (!schema) {
        throw new Error("no schema");
      }
      const pool = schema.connect();
      const first = await startServer(pgDocumentStorage(pool));
      const editor = connect(first.port);
      await editAndSync(editor, "saved on shutdown");
      // Still inside the 2 s debounce: nothing has been stored yet.
      await expect(loadDocumentState(pool, DOCUMENT)).resolves.toBeNull();

      await first.shutdown();

      const second = await startServer(pgDocumentStorage(schema.connect()));
      const reader = connect(second.port);
      await waitFor(() => reader.isSynced, "the reader's first sync");
      expect(reader.document.getText(TEXT).toString()).toBe(
        "saved on shutdown"
      );
    });

    it("keeps a document whose store failed loaded after its last editor leaves, and stores it once a retry succeeds", async () => {
      if (!schema) {
        throw new Error("no schema");
      }
      const pool = schema.connect();
      const flaky = flakyStorage(pool);
      const { server, port } = await startServer(flaky.storage);
      flaky.server = server;
      const editor = connect(port);
      await editAndSync(editor, "kept through failed stores");
      const loaded = server.hocuspocus.documents.get(DOCUMENT);

      disconnect(editor);
      await waitFor(
        () => flaky.loadedAtStore.length >= FAILED_STORES,
        "the failing stores after the last editor left"
      );
      flaky.failing = false;

      await waitFor(
        async () =>
          storedText(await loadDocumentState(pool, DOCUMENT)) ===
          "kept through failed stores",
        "a retried store to persist the edit"
      );
      expect(server.hocuspocus.getConnectionsCount()).toBe(0);
      expect(flaky.loadedAtStore.length).toBeGreaterThan(FAILED_STORES);
      for (const document of flaky.loadedAtStore) {
        expect(document).toBe(loaded);
      }
    });

    it("never unloads a document while its stores keep failing", async () => {
      if (!schema) {
        throw new Error("no schema");
      }
      const flaky = flakyStorage(schema.connect());
      const { server, port } = await startServer(flaky.storage);
      flaky.server = server;
      const editor = connect(port);
      await editAndSync(editor, "never stored");
      const loaded = server.hocuspocus.documents.get(DOCUMENT);

      disconnect(editor);
      await waitFor(
        () => flaky.loadedAtStore.length >= FAILED_STORES,
        "stores to keep being retried after the last editor left"
      );

      expect(server.hocuspocus.getConnectionsCount()).toBe(0);
      expect(server.hocuspocus.documents.get(DOCUMENT)).toBe(loaded);
      for (const document of flaky.loadedAtStore) {
        expect(document).toBe(loaded);
      }
      // Lets the shutdown in afterEach store the document and unload it.
      flaky.failing = false;
    });

    it("stores the edits a reconnecting editor resends after a hard kill lost them", async () => {
      if (!schema) {
        throw new Error("no schema");
      }
      const pool = schema.connect();
      // A process killed before its debounced store fired served the edit and
      // stored nothing. In-process, the unload that follows the dropped sockets
      // would still store, so this server's store goes nowhere.
      const killed = await startServer({
        ...pgDocumentStorage(pool),
        store: () => Promise.resolve(),
        close: () => Promise.resolve(),
      });
      const editor = connect(killed.port);
      await editAndSync(editor, "held by the editor");
      killed.kill();
      await waitFor(
        () => killed.server.hocuspocus.getConnectionsCount() === 0,
        "the killed server's connections to drop"
      );
      await expect(loadDocumentState(pool, DOCUMENT)).resolves.toBeNull();

      await startServer(pgDocumentStorage(schema.connect()), killed.port);

      await waitFor(
        async () =>
          storedText(await loadDocumentState(pool, DOCUMENT)) ===
          "held by the editor",
        "the reconnected editor's edit to be stored"
      );
    });
  }
);
