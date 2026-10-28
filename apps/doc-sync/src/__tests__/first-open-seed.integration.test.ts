import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Server } from "@hocuspocus/server";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { fragmentPlainText } from "@repo/document-schema/comment-anchor";
import { HttpServiceErrorCode } from "@repo/http-service/errors";
import { createInternalOidcVerifier } from "@repo/http-service/internal-oidc";
import {
  createOidcFixture,
  OIDC_CONFIG,
  type OidcFixture,
} from "@repo/http-service/test-support/oidc-fixture";
import {
  DocSyncDocumentCommand,
  docSyncDocumentPath,
  FirstOpenSeedState,
} from "@repo/realtime-contract/doc-sync-internal";
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
import type { Doc } from "yjs";
import type { NeverStoredTracker } from "../commands/first-open-seed";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import {
  createDocSyncServer,
  DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
} from "../server";
import { loadDocumentState } from "../storage/document-state";
import { pgDocumentStorage } from "../storage/document-storage";
import { MIGRATIONS_DIR, runMigrations } from "../storage/migrate";
import { DOCUMENT_NAME, documentToken, PUBLIC_KEYS } from "./auth/test-tokens";
import { integrationPg } from "./integration/integration-env";
import {
  createTestSchema,
  type TestSchema,
  waitFor,
} from "./integration/test-schema";
import { appendParagraph } from "./support/documents";

const trackers = vi.hoisted((): NeverStoredTracker[] => []);

vi.mock("../commands/first-open-seed", async (importOriginal) => {
  const actual: typeof import("../commands/first-open-seed") =
    await importOriginal();
  return {
    ...actual,
    createNeverStoredTracker: () => {
      const tracker = actual.createNeverStoredTracker();
      trackers.push(tracker);
      return tracker;
    },
  };
});

const SEEDED_TEXT = "the latest version's paragraph";
const SEED_BODY = JSON.stringify({
  markdown: `# Plan\n\n${SEEDED_TEXT}`,
  version: 4,
});
/** `SEED_VERSION_MAX_BODY_BYTES` as PLN-2229 T-5.3 states it, not read from the constant under test. */
const FIVE_MIB = 5 * 1024 * 1024;

type Started = {
  port: number;
  server: Server;
  tracker: NeverStoredTracker;
  shutdown: () => Promise<void>;
};

let schema: TestSchema | undefined;
let fixture: OidcFixture;
const servers: Started[] = [];
const providers: HocuspocusProvider[] = [];

beforeAll(async () => {
  fixture = await createOidcFixture();
});

async function startServer(pool: pg.Pool): Promise<Started> {
  const { server, shutdown } = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
    },
    pgDocumentStorage(pool),
    {
      verifyInternalOidc: createInternalOidcVerifier(OIDC_CONFIG, {
        unavailableEvent: DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
        fetch: fixture.servingJwks(),
      }),
      flushLogs: () => Promise.resolve(),
    }
  );
  await server.listen();
  const tracker = trackers.at(-1);
  if (!tracker) {
    throw new Error("the server made no tracker");
  }
  const started = { port: server.address.port, server, tracker, shutdown };
  servers.push(started);
  return started;
}

async function connectEditor(port: number): Promise<HocuspocusProvider> {
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: DOCUMENT_NAME,
    token: await documentToken(GrantAccess.Write),
  });
  providers.push(provider);
  await waitFor(() => provider.isSynced, "the provider's first sync");
  return provider;
}

function disconnect(provider: HocuspocusProvider): void {
  provider.configuration.websocketProvider.destroy();
  provider.destroy();
}

function pathOf(command: DocSyncDocumentCommand): string {
  const path = docSyncDocumentPath(DOCUMENT_NAME, command);
  if (path === undefined) {
    throw new Error(`${DOCUMENT_NAME} is not addressable`);
  }
  return path;
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: string
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await fixture.mint()}`,
    },
    body,
  });
}

function probe(port: number): Promise<Response> {
  return call(port, "GET", pathOf(DocSyncDocumentCommand.FirstOpenSeed));
}

function apply(port: number, body = SEED_BODY): Promise<Response> {
  return call(
    port,
    "POST",
    pathOf(DocSyncDocumentCommand.SeedIfNeverStored),
    body
  );
}

async function probedState(port: number): Promise<unknown> {
  return ((await (await probe(port)).json()) as { state: unknown }).state;
}

function textOf(doc: Doc): string {
  return fragmentPlainText(doc.getXmlFragment(DOCUMENT_FRAGMENT_FIELD));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe.skipIf(!integrationPg)("the first-open seed routes", () => {
  beforeEach(async () => {
    if (!integrationPg) {
      return;
    }
    schema = await createTestSchema(integrationPg);
    await runMigrations(schema.connect(), MIGRATIONS_DIR);
  });

  afterEach(async () => {
    for (const provider of providers.splice(0)) {
      disconnect(provider);
    }
    await Promise.all(servers.splice(0).map((started) => started.shutdown()));
    trackers.splice(0);
    await schema?.drop();
    schema = undefined;
  });

  function testPool(): pg.Pool {
    if (!schema) {
      throw new Error("no schema");
    }
    return schema.connect();
  }

  it("applies two concurrent first opens once, and both editors see the content once", async () => {
    const { port } = await startServer(testPool());

    const states = await Promise.all([probedState(port), probedState(port)]);
    const applies = await Promise.all([apply(port), apply(port)]);
    const bodies = (await Promise.all(
      applies.map((response) => response.json())
    )) as { applied: boolean }[];

    expect(states).toEqual([
      FirstOpenSeedState.NeedsSeed,
      FirstOpenSeedState.NeedsSeed,
    ]);
    expect(applies.map((response) => response.status)).toEqual([200, 200]);
    expect(bodies.filter((body) => body.applied)).toHaveLength(1);
    const editors = await Promise.all([
      connectEditor(port),
      connectEditor(port),
    ]);
    for (const editor of editors) {
      await waitFor(
        () => textOf(editor.document).includes(SEEDED_TEXT),
        "the seed to reach the editor"
      );
      expect(occurrences(textOf(editor.document), SEEDED_TEXT)).toBe(1);
    }
  });

  it("never overwrites what an editor typed into an empty, never-seeded document", async () => {
    const { port } = await startServer(testPool());
    const editor = await connectEditor(port);
    appendParagraph(editor.document, "typed before any seed");
    await waitFor(
      async () =>
        (await probedState(port)) === FirstOpenSeedState.InMemoryNotSeedable,
      "the edit to reach the service"
    );

    const response = await apply(port);

    expect(await response.json()).toEqual({ applied: false, updateBytes: 0 });
    expect(textOf(editor.document)).toBe("typed before any seed");
  });

  it("keeps a document a browser seeded byte-identical through probe and apply", async () => {
    const pool = testPool();
    const { port, server } = await startServer(testPool());
    const editor = await connectEditor(port);
    appendParagraph(editor.document, SEEDED_TEXT);
    disconnect(editor);
    await waitFor(
      async () =>
        !server.hocuspocus.documents.has(DOCUMENT_NAME) &&
        (await loadDocumentState(pool, DOCUMENT_NAME)) !== null,
      "the browser's seed to be stored and the document to unload"
    );
    const before = await loadDocumentState(pool, DOCUMENT_NAME);

    const state = await probedState(port);
    const response = await apply(port);

    expect(state).toBe(FirstOpenSeedState.Stored);
    expect(await response.json()).toEqual({ applied: false, updateBytes: 0 });
    expect(server.hocuspocus.documents.has(DOCUMENT_NAME)).toBe(false);
    const after = await loadDocumentState(pool, DOCUMENT_NAME);
    expect(Buffer.from(after ?? []).equals(Buffer.from(before ?? []))).toBe(
      true
    );
  });

  it("writes no row for a probe that finds nothing to do", async () => {
    const pool = testPool();
    const { port, shutdown } = await startServer(testPool());

    expect(await probedState(port)).toBe(FirstOpenSeedState.NeedsSeed);
    await shutdown();

    await expect(loadDocumentState(pool, DOCUMENT_NAME)).resolves.toBeNull();
  });

  it("leaves no tracker entry, and no row, once the last editor of an untouched document leaves", async () => {
    const pool = testPool();
    const { port, server, tracker } = await startServer(testPool());
    const editor = await connectEditor(port);
    expect(tracker.has(DOCUMENT_NAME)).toBe(true);

    disconnect(editor);
    await waitFor(
      () => !server.hocuspocus.documents.has(DOCUMENT_NAME),
      "the document to unload"
    );

    expect(tracker.has(DOCUMENT_NAME)).toBe(false);
    expect(tracker.size).toBe(0);
    await expect(loadDocumentState(pool, DOCUMENT_NAME)).resolves.toBeNull();
  });

  it("answers an apply body above the seed cap 413", async () => {
    const { port } = await startServer(testPool());
    const envelope = JSON.stringify({ markdown: "", version: 1 });

    const response = await apply(
      port,
      JSON.stringify({
        markdown: "a".repeat(FIVE_MIB + 1 - envelope.length),
        version: 1,
      })
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: HttpServiceErrorCode.PayloadTooLarge,
    });
  });
});
