import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Server } from "@hocuspocus/server";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { fragmentPlainText } from "@repo/document-schema/comment-anchor";
import { OIDC_CONFIG } from "@repo/http-service/test-support/oidc-fixture";
import { log } from "@repo/observability/log";
import {
  DocSyncDocumentCommand,
  FirstOpenSeedState,
} from "@repo/realtime-contract/doc-sync-internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, Doc, type XmlFragment } from "yjs";
import {
  CommandName,
  DOC_SYNC_COMMAND_COMPLETED_EVENT,
} from "../commands/command-timer";
import {
  CommandOutcome,
  DOC_SYNC_VERSION_SEED_FAILED_EVENT,
  type DocSyncCommands,
} from "../commands/document-commands";
import type { NeverStoredTracker } from "../commands/first-open-seed";
import {
  DOC_SYNC_META_MAP,
  SEEDED_VERSION_KEY,
} from "../commands/version-seed";
import { DEFAULT_DOC_SYNC_SHUTDOWN_DEADLINE_MS } from "../env";
import { createDocSyncServer } from "../server";
import type { DocumentStorage } from "../storage/document-storage";
import { createTombstones, type Tombstones } from "../storage/tombstones";
import { DOCUMENT_NAME, PUBLIC_KEYS } from "./auth/test-tokens";
import { waitFor } from "./integration/test-schema";
import { appendParagraph, documentState } from "./support/documents";
import { memoryStorage } from "./support/memory-storage";

const gates = vi.hoisted(() => ({
  parseFails: false,
  trackers: [] as NeverStoredTracker[],
}));

vi.mock("@repo/document-schema/markdown", async (importOriginal) => {
  const actual: typeof import("@repo/document-schema/markdown") =
    await importOriginal();
  return {
    ...actual,
    markdownToDocument: (
      ...args: Parameters<typeof actual.markdownToDocument>
    ) => {
      if (gates.parseFails) {
        throw new TypeError("markdown exploded");
      }
      return actual.markdownToDocument(...args);
    },
  };
});

vi.mock("../commands/first-open-seed", async (importOriginal) => {
  const actual: typeof import("../commands/first-open-seed") =
    await importOriginal();
  return {
    ...actual,
    createNeverStoredTracker: () => {
      const tracker = actual.createNeverStoredTracker();
      gates.trackers.push(tracker);
      return tracker;
    },
  };
});

const SECRET_TEXT = "confidential first-open paragraph";
const SEED = { markdown: `# Plan\n\n${SECRET_TEXT}`, version: 3 };

type Started = {
  server: Server;
  commands: DocSyncCommands;
  rows: Map<string, Uint8Array>;
  storage: DocumentStorage;
  tombstones: Tombstones;
  tracker: NeverStoredTracker;
  shutdown: () => Promise<void>;
};

const started: Started[] = [];
const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  gates.parseFails = false;
  gates.trackers.splice(0);
  vi.restoreAllMocks();
  for (const provider of providers.splice(0)) {
    provider.configuration.websocketProvider.destroy();
    provider.destroy();
  }
  await Promise.all(started.splice(0).map(({ shutdown }) => shutdown()));
});

/** A server whose storage's reads and `store` are spies, set before the server wraps them. */
async function start(seed: [string, Uint8Array][] = []): Promise<Started> {
  const { storage, rows } = memoryStorage(seed);
  vi.spyOn(storage, "exists");
  vi.spyOn(storage, "fetch");
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
    {
      onAuthenticate: () => Promise.resolve(),
      flushLogs: () => Promise.resolve(),
      tombstones,
    }
  );
  await server.server.listen();
  const tracker = gates.trackers.at(-1);
  if (!tracker) {
    throw new Error("the server made no tracker");
  }
  const result = { ...server, rows, storage, tombstones, tracker };
  started.push(result);
  return result;
}

/** Loads the document through a real provider, which writes nothing on connect. */
async function openEditor({ server }: Started): Promise<HocuspocusProvider> {
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${server.address.port}`,
    name: DOCUMENT_NAME,
    token: "admitted-by-the-test-hook",
  });
  providers.push(provider);
  await waitFor(
    () => provider.isSynced && server.hocuspocus.documents.has(DOCUMENT_NAME),
    "the provider's first sync"
  );
  return provider;
}

function liveFragment({ server }: Started): XmlFragment {
  const document = server.hocuspocus.documents.get(DOCUMENT_NAME);
  if (!document) {
    throw new Error("the document is not loaded");
  }
  return document.getXmlFragment(DOCUMENT_FRAGMENT_FIELD);
}

async function editThenEmpty(
  running: Started,
  provider: HocuspocusProvider
): Promise<void> {
  appendParagraph(provider.document, "typed by a user");
  await waitFor(
    () => liveFragment(running).length === 1,
    "the edit to reach the service"
  );
  const fragment = provider.document.getXmlFragment(DOCUMENT_FRAGMENT_FIELD);
  fragment.delete(0, fragment.length);
  await waitFor(
    () => liveFragment(running).length === 0,
    "the deletion to reach the service"
  );
}

function storedDoc(rows: Map<string, Uint8Array>): Doc {
  const state = rows.get(DOCUMENT_NAME);
  if (!state) {
    throw new Error("nothing stored");
  }
  const doc = new Doc();
  applyUpdate(doc, state);
  return doc;
}

function textOf(fragment: XmlFragment): string {
  return fragmentPlainText(fragment);
}

describe("probeFirstOpenSeed", () => {
  it("answers stored with one exists read: no fetch, direct connection or store", async () => {
    const running = await start([[DOCUMENT_NAME, documentState()]]);
    const open = vi.spyOn(running.server.hocuspocus, "openDirectConnection");

    await expect(
      running.commands.probeFirstOpenSeed(DOCUMENT_NAME)
    ).resolves.toEqual({
      kind: CommandOutcome.Done,
      state: FirstOpenSeedState.Stored,
    });
    expect(running.storage.exists).toHaveBeenCalledTimes(1);
    expect(running.storage.fetch).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(running.storage.store).not.toHaveBeenCalled();
  });

  it("answers needs-seed for an unloaded never-stored document, and does not load it", async () => {
    const running = await start();

    await expect(
      running.commands.probeFirstOpenSeed(DOCUMENT_NAME)
    ).resolves.toEqual({
      kind: CommandOutcome.Done,
      state: FirstOpenSeedState.NeedsSeed,
    });
    expect(running.server.hocuspocus.documents.has(DOCUMENT_NAME)).toBe(false);
    expect(running.storage.fetch).not.toHaveBeenCalled();
  });

  it("answers needs-seed for a loaded, untouched, empty document", async () => {
    const running = await start();
    await openEditor(running);

    await expect(
      running.commands.probeFirstOpenSeed(DOCUMENT_NAME)
    ).resolves.toMatchObject({ state: FirstOpenSeedState.NeedsSeed });
  });

  it("answers in-memory-not-seedable for a loaded document that was edited", async () => {
    const running = await start();
    const provider = await openEditor(running);
    appendParagraph(provider.document, "typed by a user");
    await waitFor(
      () => liveFragment(running).length === 1,
      "the edit to reach the service"
    );

    await expect(
      running.commands.probeFirstOpenSeed(DOCUMENT_NAME)
    ).resolves.toMatchObject({
      state: FirstOpenSeedState.InMemoryNotSeedable,
    });
  });

  it("answers in-memory-not-seedable for a loaded document edited and emptied again", async () => {
    const running = await start();
    await editThenEmpty(running, await openEditor(running));

    await expect(
      running.commands.probeFirstOpenSeed(DOCUMENT_NAME)
    ).resolves.toMatchObject({
      state: FirstOpenSeedState.InMemoryNotSeedable,
    });
  });
});

describe("seedIfNeverStored", () => {
  it("seeds an unloaded never-stored document once, recording the seeded version", async () => {
    const running = await start();
    const infos = vi.spyOn(log, "info").mockImplementation(() => undefined);

    const first = await running.commands.seedIfNeverStored(DOCUMENT_NAME, SEED);
    const second = await running.commands.seedIfNeverStored(
      DOCUMENT_NAME,
      SEED
    );

    expect(first).toMatchObject({ kind: CommandOutcome.Done, applied: true });
    expect(
      first.kind === CommandOutcome.Done && first.updateBytes
    ).toBeGreaterThan(0);
    expect(second).toEqual({
      kind: CommandOutcome.Done,
      applied: false,
      updateBytes: 0,
    });
    const stored = storedDoc(running.rows);
    expect(
      textOf(stored.getXmlFragment(DOCUMENT_FRAGMENT_FIELD)).split(SECRET_TEXT)
    ).toHaveLength(2);
    expect(stored.getMap(DOC_SYNC_META_MAP).get(SEEDED_VERSION_KEY)).toBe(
      SEED.version
    );
    expect(infos).toHaveBeenCalledWith(expect.any(String), {
      event: DOC_SYNC_COMMAND_COMPLETED_EVENT,
      command: DocSyncDocumentCommand.SeedIfNeverStored,
      documentName: DOCUMENT_NAME,
      durationMs: expect.any(Number),
      outcome: "applied",
      version: SEED.version,
      updateBytes: expect.any(Number),
    });
    expect(infos).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: "skipped", updateBytes: 0 })
    );
    expect(JSON.stringify(infos.mock.calls)).not.toContain(SECRET_TEXT);
  });

  it("seeds a loaded, untouched document in place, with no direct connection", async () => {
    const running = await start();
    const provider = await openEditor(running);
    const open = vi.spyOn(running.server.hocuspocus, "openDirectConnection");

    await expect(
      running.commands.seedIfNeverStored(DOCUMENT_NAME, SEED)
    ).resolves.toMatchObject({ applied: true });

    expect(open).not.toHaveBeenCalled();
    await waitFor(
      () =>
        textOf(provider.document.getXmlFragment(DOCUMENT_FRAGMENT_FIELD)) !==
        "",
      "the seed to reach the editor"
    );
    expect(
      textOf(provider.document.getXmlFragment(DOCUMENT_FRAGMENT_FIELD))
    ).toContain(SECRET_TEXT);
  });

  it("opens and stores nothing for a stored document, even an empty one", async () => {
    const running = await start([[DOCUMENT_NAME, documentState()]]);
    const open = vi.spyOn(running.server.hocuspocus, "openDirectConnection");

    await expect(
      running.commands.seedIfNeverStored(DOCUMENT_NAME, SEED)
    ).resolves.toEqual({
      kind: CommandOutcome.Done,
      applied: false,
      updateBytes: 0,
    });
    expect(open).not.toHaveBeenCalled();
    expect(running.storage.fetch).not.toHaveBeenCalled();
    expect(running.storage.store).not.toHaveBeenCalled();
  });

  it.each([
    [
      "edited",
      async (running: Started, provider: HocuspocusProvider) => {
        appendParagraph(provider.document, "typed by a user");
        await waitFor(
          () => liveFragment(running).length === 1,
          "the edit to reach the service"
        );
      },
    ],
    ["edited and emptied again", editThenEmpty],
  ])(
    "skips a loaded document %s, with no direct connection",
    async (_label, touch) => {
      const running = await start();
      const provider = await openEditor(running);
      await touch(running, provider);
      const before = textOf(liveFragment(running));
      const open = vi.spyOn(running.server.hocuspocus, "openDirectConnection");

      await expect(
        running.commands.seedIfNeverStored(DOCUMENT_NAME, SEED)
      ).resolves.toEqual({
        kind: CommandOutcome.Done,
        applied: false,
        updateBytes: 0,
      });
      expect(open).not.toHaveBeenCalled();
      expect(textOf(liveFragment(running))).toBe(before);
    }
  );

  it("answers deleted for a tombstoned name on both commands, and writes no row", async () => {
    const running = await start();
    running.tombstones.add(DOCUMENT_NAME);

    await expect(
      running.commands.probeFirstOpenSeed(DOCUMENT_NAME)
    ).resolves.toEqual({ kind: CommandOutcome.Deleted });
    await expect(
      running.commands.seedIfNeverStored(DOCUMENT_NAME, SEED)
    ).resolves.toEqual({ kind: CommandOutcome.Deleted });
    expect(running.rows.has(DOCUMENT_NAME)).toBe(false);
  });

  it("answers seed_failed when the markdown does not parse, logged once without content", async () => {
    const running = await start();
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const open = vi.spyOn(running.server.hocuspocus, "openDirectConnection");
    gates.parseFails = true;

    await expect(
      running.commands.seedIfNeverStored(DOCUMENT_NAME, SEED)
    ).resolves.toEqual({ kind: CommandOutcome.SeedFailed });

    expect(open).not.toHaveBeenCalled();
    expect(running.rows.has(DOCUMENT_NAME)).toBe(false);
    expect(
      errors.mock.calls.filter(
        ([, fields]) =>
          (fields as { event?: string } | undefined)?.event ===
          DOC_SYNC_VERSION_SEED_FAILED_EVENT
      )
    ).toEqual([
      [
        expect.any(String),
        {
          event: DOC_SYNC_VERSION_SEED_FAILED_EVENT,
          command: CommandName.SeedIfNeverStored,
          documentName: DOCUMENT_NAME,
          version: SEED.version,
          code: "TypeError",
        },
      ],
    ]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(SECRET_TEXT);
  });
});

describe("the never-stored tracker", () => {
  it("holds a document loaded from an empty fetch until its first update", async () => {
    const running = await start();
    const provider = await openEditor(running);
    expect(running.tracker.has(DOCUMENT_NAME)).toBe(true);

    appendParagraph(provider.document, "typed by a user");
    await waitFor(
      () => liveFragment(running).length === 1,
      "the edit to reach the service"
    );

    expect(running.tracker.has(DOCUMENT_NAME)).toBe(false);
  });

  it("never holds a document loaded from a stored row", async () => {
    const running = await start([[DOCUMENT_NAME, documentState()]]);
    await openEditor(running);

    expect(running.tracker.has(DOCUMENT_NAME)).toBe(false);
  });

  it("leaves no entry once an untouched document unloads", async () => {
    const running = await start();
    const provider = await openEditor(running);
    expect(running.tracker.has(DOCUMENT_NAME)).toBe(true);

    provider.configuration.websocketProvider.destroy();
    provider.destroy();
    await waitFor(
      () => !running.server.hocuspocus.documents.has(DOCUMENT_NAME),
      "the document to unload"
    );

    expect(running.tracker.has(DOCUMENT_NAME)).toBe(false);
    expect(running.tracker.size).toBe(0);
  });
});
