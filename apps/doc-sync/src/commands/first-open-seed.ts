import type { Document, Hocuspocus } from "@hocuspocus/server";
import { markdownToDocument } from "@repo/document-schema/markdown";
import {
  DocSyncChangeSource,
  FirstOpenSeedState,
  type SeedIfNeverStoredRequest,
  SeedVersionMode,
} from "@repo/realtime-contract/doc-sync-internal";
import type { DocumentStorage } from "../storage/document-storage";
import type { CommandOutcome, DocumentDeleted } from "./document-commands";
import {
  applyVersionSeed,
  isFirstOpenSeedable,
  type MeasuredSeed,
  measuredSeed,
} from "./version-seed";

/**
 * The names of documents whose load found no stored state and that have not
 * changed since (ISS-12508). The storage fetch adds a name; the document's
 * first update or its unload removes it, so the set never holds more names
 * than there are open documents.
 */
export type NeverStoredTracker = {
  markLoadedFromNull: (documentName: string) => void;
  /** Called from `afterLoadDocument`: any change, from a client or a command, ends "untouched". */
  watch: (document: Document) => void;
  forget: (documentName: string) => void;
  has: (documentName: string) => boolean;
  readonly size: number;
};

export function createNeverStoredTracker(): NeverStoredTracker {
  const names = new Set<string>();
  return {
    markLoadedFromNull: (documentName) => {
      names.add(documentName);
    },
    watch: (document) => {
      if (names.has(document.name)) {
        document.once("update", () => {
          names.delete(document.name);
        });
      }
    },
    forget: (documentName) => {
      names.delete(documentName);
    },
    has: (documentName) => names.has(documentName),
    get size() {
      return names.size;
    },
  };
}

export type FirstOpenSeedDeps = {
  hocuspocus: Pick<
    Hocuspocus,
    | "documents"
    | "loadingDocuments"
    | "unloadingDocuments"
    | "openDirectConnection"
  >;
  storage: Pick<DocumentStorage, "exists">;
  neverStored: Pick<NeverStoredTracker, "has">;
};

export type FirstOpenSeedProbeResult =
  | { kind: typeof CommandOutcome.Done; state: FirstOpenSeedState }
  | DocumentDeleted;

export type FirstOpenSeedApplied = MeasuredSeed;

export type SeedIfNeverStoredResult =
  | ({ kind: typeof CommandOutcome.Done } & FirstOpenSeedApplied)
  | { kind: typeof CommandOutcome.SeedFailed }
  | DocumentDeleted;

/**
 * The probe: one `exists` read for a stored document, and nothing else. It
 * never loads a document and never opens a direct connection; a loaded one is
 * read synchronously, with no transaction or write.
 */
export async function firstOpenSeedState(
  { hocuspocus, storage, neverStored }: FirstOpenSeedDeps,
  documentName: string
): Promise<FirstOpenSeedState> {
  if (await storage.exists(documentName)) {
    return FirstOpenSeedState.Stored;
  }
  const loaded = await settledDocument(hocuspocus, documentName);
  if (loaded === undefined) {
    return FirstOpenSeedState.NeedsSeed;
  }
  return isFirstOpenSeedable(loaded, neverStored)
    ? FirstOpenSeedState.NeedsSeed
    : FirstOpenSeedState.InMemoryNotSeedable;
}

/**
 * The apply, authoritative where the probe is advisory: it trusts nothing the
 * probe answered. A stored document is left alone with nothing opened or
 * stored. A loaded one is seeded in one transaction on the live document, with
 * no direct connection, so a no-op stores nothing and an applied seed is
 * stored by the normal debounced update path. Only a document neither stored
 * nor in memory is opened through a direct connection. Throws when the
 * markdown does not parse or the seed does not run.
 */
export async function applyFirstOpenSeed(
  { hocuspocus, storage, neverStored }: FirstOpenSeedDeps,
  documentName: string,
  { markdown, version }: SeedIfNeverStoredRequest
): Promise<FirstOpenSeedApplied> {
  if (await storage.exists(documentName)) {
    return { applied: false, updateBytes: 0 };
  }
  const content = markdownToDocument(markdown);
  const seed = (live: Document) =>
    isFirstOpenSeedable(live, neverStored) &&
    applyVersionSeed(live, content, version, SeedVersionMode.Publish).applied;
  const context = { source: DocSyncChangeSource.SeedVersion, version };
  const loaded = await settledDocument(hocuspocus, documentName);
  if (loaded) {
    return measuredSeed(
      loaded,
      (edit) => loaded.transact(edit, { source: "local", context }),
      seed
    );
  }
  const connection = await hocuspocus.openDirectConnection(
    documentName,
    context
  );
  try {
    const { document } = connection;
    if (!document) {
      throw new Error("The direct connection closed before the seed ran");
    }
    return await measuredSeed(
      document,
      (edit) => connection.transact(edit),
      seed
    );
  } finally {
    await connection.disconnect();
  }
}

/** The document once any load or unload of its name has settled; `undefined` when it is not in memory. */
async function settledDocument(
  hocuspocus: FirstOpenSeedDeps["hocuspocus"],
  documentName: string
): Promise<Document | undefined> {
  await hocuspocus.loadingDocuments.get(documentName)?.catch(() => undefined);
  await hocuspocus.unloadingDocuments.get(documentName);
  return hocuspocus.documents.get(documentName);
}
