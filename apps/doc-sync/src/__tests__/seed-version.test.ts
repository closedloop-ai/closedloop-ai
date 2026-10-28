import {
  type DirectConnection,
  Document,
  type Server,
} from "@hocuspocus/server";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { fragmentPlainText } from "@repo/document-schema/comment-anchor";
import { OIDC_CONFIG } from "@repo/http-service/test-support/oidc-fixture";
import { log } from "@repo/observability/log";
import {
  DocSyncDocumentCommand,
  SeedVersionMode,
} from "@repo/realtime-contract/doc-sync-internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, Doc, XmlElement } from "yjs";
import {
  CommandName,
  DOC_SYNC_COMMAND_COMPLETED_EVENT,
} from "../commands/command-timer";
import {
  CommandOutcome,
  DOC_SYNC_VERSION_SEED_FAILED_EVENT,
  type DocSyncCommands,
} from "../commands/document-commands";
import {
  DOC_SYNC_META_MAP,
  isFirstOpenSeedable,
  SEEDED_VERSION_KEY,
} from "../commands/version-seed";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import { createDocSyncServer } from "../server";
import { createTombstones, type Tombstones } from "../storage/tombstones";
import { DOCUMENT_NAME, PUBLIC_KEYS } from "./auth/test-tokens";
import { appendParagraph } from "./support/documents";
import { memoryStorage } from "./support/memory-storage";

const seedGate = vi.hoisted((): { fail: boolean } => ({ fail: false }));

vi.mock("../commands/version-seed", async (importOriginal) => {
  const actual: typeof import("../commands/version-seed") =
    await importOriginal();
  return {
    ...actual,
    applyVersionSeed: (...args: Parameters<typeof actual.applyVersionSeed>) => {
      if (seedGate.fail) {
        throw new TypeError("seed exploded");
      }
      return actual.applyVersionSeed(...args);
    },
  };
});

const SECRET_TEXT = "confidential paragraph body";

type Started = {
  server: Server;
  commands: DocSyncCommands;
  rows: Map<string, Uint8Array>;
  tombstones: Tombstones;
  shutdown: () => Promise<void>;
};

const started: Started[] = [];

afterEach(async () => {
  seedGate.fail = false;
  vi.restoreAllMocks();
  await Promise.all(started.splice(0).map(({ shutdown }) => shutdown()));
});

async function start(): Promise<Started> {
  const { storage, rows } = memoryStorage();
  const tombstones = createTombstones();
  const server = createDocSyncServer(
    {
      port: 0,
      shutdownDeadlineMs: DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS,
      tokenPublicKeys: PUBLIC_KEYS,
      allowedOrigins: [],
      internalOidc: OIDC_CONFIG,
    },
    storage,
    { flushLogs: () => Promise.resolve(), tombstones }
  );
  await server.server.listen();
  const result = { ...server, rows, tombstones };
  started.push(result);
  return result;
}

/** The stored document, decoded. */
function storedDoc(rows: Map<string, Uint8Array>): Doc {
  const state = rows.get(DOCUMENT_NAME);
  if (!state) {
    throw new Error("nothing stored");
  }
  const doc = new Doc();
  applyUpdate(doc, state);
  return doc;
}

function storedText(rows: Map<string, Uint8Array>): string {
  return fragmentPlainText(
    storedDoc(rows).getXmlFragment(DOCUMENT_FRAGMENT_FIELD)
  );
}

function topLevelNodeNames(rows: Map<string, Uint8Array>): string[] {
  return storedDoc(rows)
    .getXmlFragment(DOCUMENT_FRAGMENT_FIELD)
    .toArray()
    .map((node) => (node instanceof XmlElement ? node.nodeName : "text"));
}

describe("seedVersion", () => {
  it("applies the version's content to the live document as a diff", async () => {
    const { commands, rows } = await start();
    const infos = vi.spyOn(log, "info").mockImplementation(() => undefined);

    const result = await commands.seedVersion(DOCUMENT_NAME, {
      markdown: `# Plan\n\n${SECRET_TEXT}`,
      version: 1,
    });

    expect(result).toMatchObject({
      kind: CommandOutcome.Seeded,
      applied: true,
      stale: false,
    });
    expect(
      result.kind === CommandOutcome.Seeded && result.updateBytes
    ).toBeGreaterThan(0);
    expect(storedText(rows)).toContain(SECRET_TEXT);
    expect(
      storedDoc(rows).getMap(DOC_SYNC_META_MAP).get(SEEDED_VERSION_KEY)
    ).toBe(1);
    expect(infos).toHaveBeenCalledWith(expect.any(String), {
      event: DOC_SYNC_COMMAND_COMPLETED_EVENT,
      command: DocSyncDocumentCommand.SeedVersion,
      documentName: DOCUMENT_NAME,
      durationMs: expect.any(Number),
      outcome: "applied",
      version: 1,
      updateBytes: expect.any(Number),
    });
    expect(JSON.stringify(infos.mock.calls)).not.toContain(SECRET_TEXT);
  });

  it("emits no update when the content is identical", async () => {
    const { commands } = await start();
    const request = { markdown: `# Plan\n\n${SECRET_TEXT}`, version: 1 };
    await commands.seedVersion(DOCUMENT_NAME, request);

    await expect(
      commands.seedVersion(DOCUMENT_NAME, {
        ...request,
        mode: SeedVersionMode.Reset,
      })
    ).resolves.toEqual({
      kind: CommandOutcome.Seeded,
      applied: true,
      stale: false,
      updateBytes: 0,
    });
  });

  it("applies the editor's normalizations: a mermaid fence and a trailing paragraph", async () => {
    const { commands, rows } = await start();

    await commands.seedVersion(DOCUMENT_NAME, {
      markdown: "```mermaid\ngraph TD; A-->B\n```",
      version: 1,
    });

    expect(topLevelNodeNames(rows)).toEqual(["mermaid", "paragraph"]);
  });

  it("skips a version older than the last seeded one, and an equal one outside reset mode", async () => {
    const { commands, rows } = await start();
    await commands.seedVersion(DOCUMENT_NAME, {
      markdown: "version two",
      version: 2,
    });

    await expect(
      commands.seedVersion(DOCUMENT_NAME, {
        markdown: "version one",
        version: 1,
      })
    ).resolves.toEqual({
      kind: CommandOutcome.Seeded,
      applied: false,
      stale: true,
      updateBytes: 0,
    });
    expect(storedText(rows)).toContain("version two");

    await expect(
      commands.seedVersion(DOCUMENT_NAME, {
        markdown: "version two, retried",
        version: 2,
      })
    ).resolves.toMatchObject({ applied: false, stale: true });
    await expect(
      commands.seedVersion(DOCUMENT_NAME, {
        markdown: "version two, retried",
        version: 2,
        mode: SeedVersionMode.Publish,
      })
    ).resolves.toMatchObject({ applied: false, stale: true });
    expect(storedText(rows)).not.toContain("retried");

    await expect(
      commands.seedVersion(DOCUMENT_NAME, {
        markdown: "version two, reset",
        version: 2,
        mode: SeedVersionMode.Reset,
      })
    ).resolves.toMatchObject({ applied: true, stale: false });
    expect(storedText(rows)).toContain("version two, reset");
  });

  it("answers seed_failed when the direct connection never runs the seed", async () => {
    const { server, commands } = await start();
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    const open = server.hocuspocus.openDirectConnection.bind(server.hocuspocus);
    vi.spyOn(server.hocuspocus, "openDirectConnection").mockImplementation(
      async (...args) => {
        const connection = await open(...args);
        vi.spyOn(connection, "transact").mockResolvedValue(undefined);
        return connection;
      }
    );

    await expect(
      commands.seedVersion(DOCUMENT_NAME, { markdown: "x", version: 1 })
    ).resolves.toEqual({ kind: CommandOutcome.SeedFailed });
  });

  it("answers deleted for a tombstoned name and opens no direct connection", async () => {
    const { server, commands, tombstones, rows } = await start();
    const open = vi.spyOn(server.hocuspocus, "openDirectConnection");
    tombstones.add(DOCUMENT_NAME);

    await expect(
      commands.seedVersion(DOCUMENT_NAME, { markdown: "x", version: 1 })
    ).resolves.toEqual({ kind: CommandOutcome.Deleted });
    expect(open).not.toHaveBeenCalled();
    expect(rows.has(DOCUMENT_NAME)).toBe(false);
  });

  it("closes the connection on a throw, returns seed_failed and logs once without content", async () => {
    const { server, commands } = await start();
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const offCalls: string[] = [];
    const connections: DirectConnection[] = [];
    const open = server.hocuspocus.openDirectConnection.bind(server.hocuspocus);
    vi.spyOn(server.hocuspocus, "openDirectConnection").mockImplementation(
      async (...args) => {
        const connection = await open(...args);
        const document = connection.document;
        if (document) {
          const off = document.off.bind(document);
          vi.spyOn(document, "off").mockImplementation((name, handler) => {
            offCalls.push(name);
            off(name, handler);
          });
        }
        connections.push(connection);
        return connection;
      }
    );
    seedGate.fail = true;

    await expect(
      commands.seedVersion(DOCUMENT_NAME, { markdown: SECRET_TEXT, version: 4 })
    ).resolves.toEqual({ kind: CommandOutcome.SeedFailed });

    expect(offCalls).toContain("update");
    expect(connections.map((connection) => connection.document)).toEqual([
      null,
    ]);
    expect(server.hocuspocus.documents.has(DOCUMENT_NAME)).toBe(false);
    const seedFailures = errors.mock.calls.filter(
      ([, fields]) =>
        (fields as { event?: string } | undefined)?.event ===
        DOC_SYNC_VERSION_SEED_FAILED_EVENT
    );
    expect(seedFailures).toEqual([
      [
        expect.any(String),
        {
          event: DOC_SYNC_VERSION_SEED_FAILED_EVENT,
          command: CommandName.SeedVersion,
          documentName: DOCUMENT_NAME,
          version: 4,
          code: "TypeError",
        },
      ],
    ]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(SECRET_TEXT);
  });
});

describe("isFirstOpenSeedable", () => {
  const neverStored = { has: (name: string) => name === DOCUMENT_NAME };

  it("holds for a tracked document with an empty fragment and no seeded version", () => {
    expect(isFirstOpenSeedable(new Document(DOCUMENT_NAME), neverStored)).toBe(
      true
    );
  });

  it("fails for a document the tracker does not hold", () => {
    expect(
      isFirstOpenSeedable(new Document(`${DOCUMENT_NAME}-other`), neverStored)
    ).toBe(false);
  });

  it("fails for a tracked document with content", () => {
    const document = new Document(DOCUMENT_NAME);
    appendParagraph(document, "written");

    expect(isFirstOpenSeedable(document, neverStored)).toBe(false);
  });

  it("fails for a tracked, empty document holding a seeded version", () => {
    const document = new Document(DOCUMENT_NAME);
    document.getMap<number>(DOC_SYNC_META_MAP).set(SEEDED_VERSION_KEY, 1);

    expect(isFirstOpenSeedable(document, neverStored)).toBe(false);
  });
});
