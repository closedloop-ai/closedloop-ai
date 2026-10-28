import { ResetConnection } from "@hocuspocus/common";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Server } from "@hocuspocus/server";
import { OIDC_CONFIG } from "@repo/http-service/test-support/oidc-fixture";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandOutcome,
  type DocSyncCommands,
} from "../commands/document-commands";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import { createDocSyncServer, type DocSyncServerDeps } from "../server";
import type { DocumentStorage } from "../storage/document-storage";
import { DOCUMENT_NAME, PUBLIC_KEYS } from "./auth/test-tokens";
import { waitFor } from "./integration/test-schema";
import { documentState } from "./support/documents";
import { memoryStorage } from "./support/memory-storage";

const STORED_TEXT = "the anchor text";

type Started = {
  server: Server;
  commands: DocSyncCommands;
  shutdown: () => Promise<void>;
};

const started: Started[] = [];
const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    provider.configuration.websocketProvider.destroy();
    provider.destroy();
  }
  await Promise.all(started.splice(0).map(({ shutdown }) => shutdown()));
});

async function start(
  storage: DocumentStorage,
  deps: DocSyncServerDeps = {}
): Promise<Started & { port: number }> {
  const server = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
    },
    storage,
    { flushLogs: () => Promise.resolve(), ...deps }
  );
  started.push(server);
  await server.server.listen();
  return { ...server, port: server.server.address.port };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** `storage` whose `method` answers, then waits for `release` after calling `entered`. */
function holdAfterRead(
  storage: DocumentStorage,
  method: "exists" | "fetch"
): {
  storage: DocumentStorage;
  entered: Promise<void>;
  release: () => void;
} {
  const entered = deferred();
  const released = deferred();
  const read = storage[method];
  const held = async (name: string) => {
    const answer = await read(name);
    entered.resolve();
    await released.promise;
    return answer;
  };
  return {
    storage: { ...storage, [method]: held },
    entered: entered.promise,
    release: released.resolve,
  };
}

describe("a delete landing inside a command", () => {
  it.each([
    {
      command: "comment anchor",
      heldRead: "exists" as const,
      run: (commands: DocSyncCommands) =>
        commands.addCommentAnchor(DOCUMENT_NAME, {
          threadId: "thread-1",
          anchorText: STORED_TEXT,
        }),
    },
    {
      command: "clear",
      heldRead: "exists" as const,
      run: (commands: DocSyncCommands) => commands.clear(DOCUMENT_NAME),
    },
    {
      command: "text",
      heldRead: "fetch" as const,
      run: (commands: DocSyncCommands) => commands.readText(DOCUMENT_NAME),
    },
  ])(
    "answers $command deleted when the delete lands after its storage read",
    async ({ heldRead, run }) => {
      const { storage: rows } = memoryStorage([
        [DOCUMENT_NAME, documentState(STORED_TEXT)],
      ]);
      const { storage, entered, release } = holdAfterRead(rows, heldRead);
      const { commands } = await start(storage);

      const running = run(commands);
      await entered;
      await expect(commands.deleteDocument(DOCUMENT_NAME)).resolves.toEqual({
        kind: CommandOutcome.Done,
        deleted: true,
        wasLoaded: false,
      });
      release();

      await expect(running).resolves.toEqual({ kind: CommandOutcome.Deleted });
    }
  );
});

describe("a delete landing between onAuthenticate and the document load", () => {
  it("closes the connection that attaches to the deleted name", async () => {
    const { storage, rows } = memoryStorage([
      [DOCUMENT_NAME, documentState(STORED_TEXT)],
    ]);
    let deleting: ReturnType<DocSyncCommands["deleteDocument"]> | undefined;
    let commands: DocSyncCommands | undefined;
    const { server, port, ...rest } = await start(storage, {
      // The first admission issues the delete as its hook resolves, past any
      // tombstone check the hook made; later admissions are refused, as a
      // tombstoned name's are.
      onAuthenticate: () => {
        if (deleting) {
          return Promise.reject(new Error("tombstoned"));
        }
        deleting = commands?.deleteDocument(DOCUMENT_NAME);
        return Promise.resolve();
      },
    });
    commands = rest.commands;
    const closeReasons: string[] = [];
    providers.push(
      new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}`,
        name: DOCUMENT_NAME,
        token: "any-token",
        onClose: ({ event }) => {
          closeReasons.push(event.reason);
        },
      })
    );
    await waitFor(() => deleting !== undefined, "the delete to be issued");

    await expect(deleting).resolves.toEqual({
      kind: CommandOutcome.Done,
      deleted: true,
      wasLoaded: false,
    });
    await waitFor(
      () => closeReasons.includes(ResetConnection.reason),
      "the connection to be closed with Reset Connection"
    );
    await waitFor(
      () => !server.hocuspocus.documents.has(DOCUMENT_NAME),
      "the blank document to unload"
    );
    expect(server.hocuspocus.getConnectionsCount()).toBe(0);
    expect(rows.has(DOCUMENT_NAME)).toBe(false);
  });
});
