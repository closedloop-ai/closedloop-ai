import { HocuspocusProvider } from "@hocuspocus/provider";
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
  DocSyncInternalErrorCode,
  docSyncDocumentPath,
} from "@repo/realtime-contract/doc-sync-internal";
import { RoomNamespace } from "@repo/realtime-contract/document-room";
import { GrantAccess } from "@repo/realtime-contract/grants";
import type pg from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyUpdate, Doc } from "yjs";
import {
  DOC_SYNC_META_MAP,
  SEEDED_VERSION_KEY,
} from "../commands/version-seed";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import { MAX_INTERNAL_BODY_BYTES } from "../http/internal-routes";
import {
  createDocSyncServer,
  DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
} from "../server";
import { loadDocumentState } from "../storage/document-state";
import { pgDocumentStorage } from "../storage/document-storage";
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
import { appendParagraph } from "./support/documents";

const SEEDED_TEXT = "the published version's paragraph";

type Started = { port: number; shutdown: () => Promise<void> };

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
  const started = { port: server.address.port, shutdown };
  servers.push(started);
  return started;
}

type Editor = { provider: HocuspocusProvider; statelessPayloads: string[] };

async function connectEditor(port: number): Promise<Editor> {
  const statelessPayloads: string[] = [];
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: DOCUMENT_NAME,
    token: await documentToken(GrantAccess.Write),
    onStateless: ({ payload }) => {
      statelessPayloads.push(payload);
    },
  });
  providers.push(provider);
  await waitFor(() => provider.isSynced, "the provider's first sync");
  return { provider, statelessPayloads };
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
  { body, token }: { body?: string; token?: string | null } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const bearer = token === undefined ? await fixture.mint() : token;
  if (bearer !== null) {
    headers.authorization = `Bearer ${bearer}`;
  }
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
}

function seed(
  port: number,
  markdown: string,
  version: number,
  name = DOCUMENT_NAME
): Promise<Response> {
  return call(port, "POST", pathOf(name, DocSyncDocumentCommand.SeedVersion), {
    body: JSON.stringify({ markdown, version }),
  });
}

/** A seed body of exactly `bytes` bytes: its markdown pads the envelope. */
function seedBodyOfSize(bytes: number, version = 1): string {
  const envelope = JSON.stringify({ markdown: "", version });
  return JSON.stringify({
    markdown: "a".repeat(bytes - envelope.length),
    version,
  });
}

/** `SEED_VERSION_MAX_BODY_BYTES` as AC-018 states it, not read from the constant under test. */
const FIVE_MIB = 5 * 1024 * 1024;

function textOf(doc: Doc): string {
  return fragmentPlainText(doc.getXmlFragment(DOCUMENT_FRAGMENT_FIELD));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe.skipIf(!integrationPg)("the seed-version route", () => {
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

  it("reaches both open editors as a sync update, once, with no stateless message", async () => {
    const { port } = await startServer(testPool());
    const first = await connectEditor(port);
    const second = await connectEditor(port);
    appendParagraph(first.provider.document, "an earlier draft");
    await waitFor(
      () => textOf(second.provider.document).includes("an earlier draft"),
      "the draft to reach the second editor"
    );

    const response = await seed(port, SEEDED_TEXT, 1);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      applied: true,
      stale: false,
    });
    for (const editor of [first, second]) {
      await waitFor(
        () => textOf(editor.provider.document).includes(SEEDED_TEXT),
        "the seed to reach the editor"
      );
      const text = textOf(editor.provider.document);
      expect(occurrences(text, SEEDED_TEXT)).toBe(1);
      expect(text).not.toContain("an earlier draft");
      expect(editor.statelessPayloads).toEqual([]);
    }
  });

  it("undoes an editor's write to the seeded version, so it cannot block later publishes", async () => {
    const { port } = await startServer(testPool());
    const editor = await connectEditor(port);
    expect((await seed(port, "version one", 1)).status).toBe(200);
    const meta = editor.provider.document.getMap(DOC_SYNC_META_MAP);
    await waitFor(
      () => meta.get(SEEDED_VERSION_KEY) === 1,
      "the seeded version to reach the editor"
    );

    meta.set(SEEDED_VERSION_KEY, 1e9);
    await waitFor(
      () => meta.get(SEEDED_VERSION_KEY) === 1,
      "the service to undo the editor's write"
    );
    const response = await seed(port, SEEDED_TEXT, 2);

    expect(await response.json()).toMatchObject({
      applied: true,
      stale: false,
    });
    await waitFor(
      () => textOf(editor.provider.document).includes(SEEDED_TEXT),
      "the second seed to reach the editor"
    );
  });

  it("seeds and stores a document that was never stored", async () => {
    const pool = testPool();
    const { port } = await startServer(testPool());
    await expect(loadDocumentState(pool, DOCUMENT_NAME)).resolves.toBeNull();

    const response = await seed(port, SEEDED_TEXT, 1);

    expect(response.status).toBe(200);
    let stored: Uint8Array | null = null;
    await waitFor(async () => {
      stored = await loadDocumentState(pool, DOCUMENT_NAME);
      return stored !== null;
    }, "the seed to be stored");
    const doc = new Doc();
    applyUpdate(doc, stored ?? new Uint8Array());
    expect(occurrences(textOf(doc), SEEDED_TEXT)).toBe(1);
  });

  it("refuses a seed after a delete with 410, and never recreates the row", async () => {
    const pool = testPool();
    const { port, shutdown } = await startServer(testPool());
    expect((await seed(port, "stored before the delete", 1)).status).toBe(200);
    await waitFor(
      async () => (await loadDocumentState(pool, DOCUMENT_NAME)) !== null,
      "the first seed to be stored"
    );
    expect((await call(port, "DELETE", pathOf(DOCUMENT_NAME))).status).toBe(
      200
    );

    const response = await seed(port, SEEDED_TEXT, 2);

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      code: DocSyncInternalErrorCode.DocumentDeleted,
    });
    await shutdown();
    await expect(loadDocumentState(pool, DOCUMENT_NAME)).resolves.toBeNull();
  });

  it("applies its own body cap: above the command cap is accepted, above the seed cap is 413", async () => {
    const { port } = await startServer(testPool());
    const path = pathOf(DOCUMENT_NAME, DocSyncDocumentCommand.SeedVersion);

    const aboveCommandCap = await call(port, "POST", path, {
      body: seedBodyOfSize(MAX_INTERNAL_BODY_BYTES + 1),
    });
    const aboveSeedCap = await call(port, "POST", path, {
      body: seedBodyOfSize(FIVE_MIB + 1, 0),
    });
    // Version 0 fails the schema, so a body at the bound is answered after
    // the cap admits it, without parsing 5 MiB of markdown.
    const atFiveMib = await call(port, "POST", path, {
      body: seedBodyOfSize(FIVE_MIB, 0),
    });

    expect(atFiveMib.status).toBe(400);
    expect(await atFiveMib.json()).toEqual({
      code: HttpServiceErrorCode.InvalidBody,
    });
    expect(aboveCommandCap.status).toBe(200);
    expect(aboveSeedCap.status).toBe(413);
    expect(await aboveSeedCap.json()).toEqual({
      code: HttpServiceErrorCode.PayloadTooLarge,
    });
  });

  it("refuses a call without the OIDC token, and a non-canonical name", async () => {
    const { port } = await startServer(testPool());
    const body = JSON.stringify({ markdown: SEEDED_TEXT, version: 1 });

    const unauthenticated = await call(
      port,
      "POST",
      pathOf(DOCUMENT_NAME, DocSyncDocumentCommand.SeedVersion),
      { body, token: null }
    );
    const nonCanonical = await seed(
      port,
      SEEDED_TEXT,
      1,
      `${ORG}:${RoomNamespace.Document}:PLN-1`
    );

    expect(unauthenticated.status).toBe(401);
    expect(nonCanonical.status).toBe(400);
    expect(await nonCanonical.json()).toEqual({
      code: DocSyncInternalErrorCode.InvalidDocumentName,
    });
  });
});
