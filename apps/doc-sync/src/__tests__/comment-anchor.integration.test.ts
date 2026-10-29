import { HocuspocusProvider } from "@hocuspocus/provider";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { createInternalOidcVerifier } from "@repo/http-service/internal-oidc";
import {
  createOidcFixture,
  OIDC_CONFIG,
  type OidcFixture,
} from "@repo/http-service/test-support/oidc-fixture";
import {
  DocSyncDocumentCommand,
  DocSyncInternalErrorCode,
  docSyncDocumentPath,
} from "@repo/realtime-contract/doc-sync-internal";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyUpdate, Doc, XmlElement, XmlText } from "yjs";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import {
  createDocSyncServer,
  DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
} from "../server";
import { loadDocumentState } from "../storage/document-state";
import { pgDocumentStorage } from "../storage/document-storage";
import { MIGRATIONS_DIR, runMigrations } from "../storage/migrate";
import { DOCUMENT_NAME, PUBLIC_KEYS } from "./auth/test-tokens";
import { integrationPg } from "./integration/integration-env";
import {
  createTestSchema,
  type TestSchema,
  waitFor,
} from "./integration/test-schema";
import { appendParagraph } from "./support/documents";

const COMMENT_MARK_PREFIX = "liveblocksCommentMark--";

let schema: TestSchema | undefined;
let fixture: OidcFixture;
let shutdown: (() => Promise<void>) | undefined;
const providers: HocuspocusProvider[] = [];

beforeAll(async () => {
  fixture = await createOidcFixture();
});

/** Token auth has its own suite; this one admits every provider. */
async function startServer(): Promise<number> {
  if (!schema) {
    throw new Error("no schema");
  }
  const started = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
    },
    pgDocumentStorage(schema.connect()),
    {
      onAuthenticate: () => Promise.resolve(),
      verifyInternalOidc: createInternalOidcVerifier(OIDC_CONFIG, {
        unavailableEvent: DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
        fetch: fixture.servingJwks(),
      }),
      flushLogs: () => Promise.resolve(),
    }
  );
  shutdown = started.shutdown;
  await started.server.listen();
  return started.server.address.port;
}

async function connectSynced(port: number): Promise<HocuspocusProvider> {
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: DOCUMENT_NAME,
    token: "any-token",
  });
  providers.push(provider);
  await waitFor(() => provider.isSynced, "the provider's first sync");
  return provider;
}

/** The thread ids of every comment mark in `doc`'s document fragment. */
function markedThreadIds(doc: Doc): string[] {
  const threadIds: string[] = [];
  for (const block of doc.getXmlFragment(DOCUMENT_FRAGMENT_FIELD).toArray()) {
    if (!(block instanceof XmlElement)) {
      continue;
    }
    for (const node of block.toArray()) {
      if (!(node instanceof XmlText)) {
        continue;
      }
      for (const { attributes } of node.toDelta() as {
        attributes?: Record<string, { threadId?: string }>;
      }[]) {
        for (const [key, value] of Object.entries(attributes ?? {})) {
          if (key.startsWith(COMMENT_MARK_PREFIX) && value.threadId) {
            threadIds.push(value.threadId);
          }
        }
      }
    }
  }
  return threadIds;
}

function storedDoc(state: Uint8Array | null): Doc {
  const doc = new Doc();
  if (state) {
    applyUpdate(doc, state);
  }
  return doc;
}

async function anchor(
  port: number,
  threadId: string,
  anchorText: string
): Promise<Response> {
  return fetch(
    `http://127.0.0.1:${port}${docSyncDocumentPath(DOCUMENT_NAME, DocSyncDocumentCommand.CommentAnchors)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await fixture.mint()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ threadId, anchorText }),
    }
  );
}

describe.skipIf(!integrationPg)("the comment-anchor command", () => {
  beforeEach(async () => {
    if (!integrationPg) {
      return;
    }
    schema = await createTestSchema(integrationPg);
    await runMigrations(schema.connect(), MIGRATIONS_DIR);
  });

  afterEach(async () => {
    for (const provider of providers.splice(0)) {
      provider.configuration.websocketProvider.destroy();
      provider.destroy();
    }
    await shutdown?.();
    shutdown = undefined;
    await schema?.drop();
    schema = undefined;
  });

  it("marks unique text for every connected editor and in the stored row", async () => {
    const port = await startServer();
    const author = await connectSynced(port);
    const reader = await connectSynced(port);
    appendParagraph(author.document, "please anchor this sentence");
    await waitFor(
      () => !author.hasUnsyncedChanges,
      "the server to acknowledge the edit"
    );

    const response = await anchor(port, "th_unique", "anchor this");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ anchored: true });
    await waitFor(
      () => markedThreadIds(reader.document).includes("th_unique"),
      "the second editor to receive the mark"
    );
    const pool = schema?.connect();
    await waitFor(
      async () =>
        pool !== undefined &&
        markedThreadIds(
          storedDoc(await loadDocumentState(pool, DOCUMENT_NAME))
        ).includes("th_unique"),
      "the stored row to carry the mark"
    );
  });

  it("refuses repeated text 422 and marks nothing", async () => {
    const port = await startServer();
    const author = await connectSynced(port);
    appendParagraph(author.document, "twice here");
    appendParagraph(author.document, "and twice there");
    await waitFor(
      () => !author.hasUnsyncedChanges,
      "the server to acknowledge the edit"
    );

    const response = await anchor(port, "th_repeated", "twice");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: DocSyncInternalErrorCode.AnchorAmbiguous,
      matchCount: 2,
    });
    expect(markedThreadIds(author.document)).toEqual([]);
  });
});
