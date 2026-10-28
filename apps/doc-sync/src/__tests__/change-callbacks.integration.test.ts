import { createHash } from "node:crypto";
import {
  createServer,
  type Server as HttpServer,
  type IncomingHttpHeaders,
} from "node:http";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { OIDC_CONFIG } from "@repo/http-service/test-support/oidc-fixture";
import {
  DOC_SYNC_CALLBACK_AUDIENCE,
  DOC_SYNC_CHANGES_PATH,
  DocSyncCallbackHeader,
  DocSyncChangeSource,
  docSyncChangeCallbackSchema,
} from "@repo/realtime-contract/doc-sync-internal";
import { GrantAccess } from "@repo/realtime-contract/grants";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandOutcome } from "../commands/document-commands";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import { createDocSyncServer } from "../server";
import {
  loadDocumentState,
  saveDocumentState,
} from "../storage/document-state";
import { pgDocumentStorage } from "../storage/document-storage";
import { MIGRATIONS_DIR, runMigrations } from "../storage/migrate";
import {
  DOCUMENT_NAME,
  documentToken,
  PUBLIC_KEYS,
  USER_ID,
} from "./auth/test-tokens";
import { integrationPg } from "./integration/integration-env";
import {
  createTestSchema,
  type TestSchema,
  waitFor,
} from "./integration/test-schema";
import { appendParagraph, documentState } from "./support/documents";

const DOCUMENT_WORDS = "quartz flamingo";
const HTTP_ACCEPTED = 202;
/** What the fake signer adds; the receiver only records it. */
const FAKE_STS_URL =
  "https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity";

type Received = { path: string; headers: IncomingHttpHeaders; body: string };

type Started = ReturnType<typeof createDocSyncServer>;

let schema: TestSchema | undefined;
let receiver: HttpServer | undefined;
let receiverUrl = "";
const received: Received[] = [];
const servers: Started[] = [];
const providers: HocuspocusProvider[] = [];

/** A local stand-in for the API's POST /doc-sync/changes: records each request, answers 202. */
function startReceiver(): Promise<void> {
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(HTTP_ACCEPTED).end();
    });
  });
  const listening = receiver;
  return new Promise((resolve) => {
    listening.listen(0, "127.0.0.1", () => {
      const { port } = listening.address() as AddressInfo;
      receiverUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function startServer(pool: pg.Pool): Promise<Started & { port: number }> {
  const started = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
      callbacks: { url: receiverUrl, region: "us-east-1" },
    },
    pgDocumentStorage(pool),
    {
      flushLogs: () => Promise.resolve(),
      signChangeCallback: (bodySha256) =>
        Promise.resolve({
          [DocSyncCallbackHeader.Audience]: DOC_SYNC_CALLBACK_AUDIENCE,
          [DocSyncCallbackHeader.BodySha256]: bodySha256,
          [DocSyncCallbackHeader.StsUrl]: FAKE_STS_URL,
        }),
    }
  );
  await started.server.listen();
  servers.push(started);
  return { ...started, port: started.server.address.port };
}

async function connectEditor(port: number): Promise<HocuspocusProvider> {
  const token = await documentToken(GrantAccess.Write);
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: DOCUMENT_NAME,
    token,
  });
  providers.push(provider);
  await waitFor(() => provider.isSynced, "the provider's first sync");
  return provider;
}

async function edit(provider: HocuspocusProvider, text: string) {
  appendParagraph(provider.document, text);
  await waitFor(
    () => !provider.hasUnsyncedChanges,
    "the server to acknowledge the edit"
  );
}

describe.skipIf(!integrationPg)("change callbacks", () => {
  beforeEach(async () => {
    if (!integrationPg) {
      return;
    }
    schema = await createTestSchema(integrationPg);
    await runMigrations(schema.connect(), MIGRATIONS_DIR);
    await startReceiver();
  });

  afterEach(async () => {
    for (const provider of providers.splice(0)) {
      provider.configuration.websocketProvider.destroy();
      provider.destroy();
    }
    await Promise.all(servers.splice(0).map((started) => started.shutdown()));
    await new Promise((resolve) => receiver?.close(resolve));
    receiver = undefined;
    received.splice(0);
    await schema?.drop();
    schema = undefined;
  });

  function testPool(): pg.Pool {
    if (!schema) {
      throw new Error("no schema");
    }
    return schema.connect();
  }

  it("an edit sends exactly one callback after its store, naming the editor and the connection, and no text", async () => {
    const pool = testPool();
    const { port, shutdown } = await startServer(testPool());
    const editor = await connectEditor(port);

    await edit(editor, DOCUMENT_WORDS);
    await waitFor(
      async () => (await loadDocumentState(pool, DOCUMENT_NAME)) !== null,
      "the edit to be stored"
    );
    await waitFor(() => received.length > 0, "the change callback");
    editor.destroy();
    await shutdown();

    expect(received).toHaveLength(1);
    const [callback] = received;
    expect(callback?.path).toBe(DOC_SYNC_CHANGES_PATH);
    expect(callback?.headers[DocSyncCallbackHeader.BodySha256]).toBe(
      createHash("sha256")
        .update(callback?.body ?? "")
        .digest("hex")
    );
    expect(callback?.headers[DocSyncCallbackHeader.StsUrl]).toBe(FAKE_STS_URL);
    expect(
      docSyncChangeCallbackSchema.parse(JSON.parse(callback?.body ?? ""))
    ).toMatchObject({
      documentName: DOCUMENT_NAME,
      sources: [DocSyncChangeSource.Connection],
      editorUserIds: [USER_ID],
      mentions: [],
      mentionsTruncated: false,
    });
    for (const word of DOCUMENT_WORDS.split(" ")) {
      expect(callback?.body).not.toContain(word);
    }
  });

  it("a clear command sends a callback whose source is clear", async () => {
    const pool = testPool();
    await saveDocumentState(pool, DOCUMENT_NAME, documentState(DOCUMENT_WORDS));
    const { commands } = await startServer(testPool());

    await expect(commands.clear(DOCUMENT_NAME)).resolves.toEqual({
      kind: CommandOutcome.Done,
      cleared: true,
    });
    await waitFor(() => received.length > 0, "the change callback");

    expect(
      docSyncChangeCallbackSchema.parse(JSON.parse(received[0]?.body ?? ""))
    ).toMatchObject({
      documentName: DOCUMENT_NAME,
      sources: [DocSyncChangeSource.Clear],
      editorUserIds: [],
    });
  });

  it("a document deleted with its edit still pending sends no callback", async () => {
    const pool = testPool();
    const { port, commands, shutdown } = await startServer(testPool());
    const editor = await connectEditor(port);
    // Inside the 2 s store debounce: nothing is stored before the delete.
    await edit(editor, DOCUMENT_WORDS);

    await expect(commands.deleteDocument(DOCUMENT_NAME)).resolves.toMatchObject(
      { kind: CommandOutcome.Done, wasLoaded: true }
    );
    await shutdown();

    await expect(loadDocumentState(pool, DOCUMENT_NAME)).resolves.toBeNull();
    expect(received).toEqual([]);
  });
});
