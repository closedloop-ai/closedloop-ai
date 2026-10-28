import type { Document, Hocuspocus } from "@hocuspocus/server";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import {
  AnchorKind,
  type AnchorLocation,
  applyCommentMark,
  fragmentPlainText,
  locateAnchor,
} from "@repo/document-schema/comment-anchor";
import { markdownToDocument } from "@repo/document-schema/markdown";
import { log } from "@repo/observability/log";
import {
  type CommentAnchorRequest,
  DocSyncChangeSource,
  DocSyncInternalErrorCode,
  type ListDocumentsResponse,
  type SeedIfNeverStoredRequest,
  type SeedVersionRequest,
} from "@repo/realtime-contract/doc-sync-internal";
import type { DocumentStorage } from "../storage/document-storage";
import { errorCode } from "../storage/error-code";
import type { Tombstones } from "../storage/tombstones";
import { CommandName, commandTimer } from "./command-timer";
import { storedPlainText, withDirectConnection } from "./direct-connection";
import {
  applyFirstOpenSeed,
  type FirstOpenSeedProbeResult,
  firstOpenSeedState,
  type NeverStoredTracker,
  type SeedIfNeverStoredResult,
} from "./first-open-seed";
import { raceDeadline, unloadWaiter } from "./unload-waiter";
import { applyVersionSeed, measuredSeed } from "./version-seed";

export const DOC_SYNC_DELETE_UNLOAD_TIMEOUT_EVENT =
  "doc_sync.delete_unload_timeout";
export const DOC_SYNC_VERSION_SEED_FAILED_EVENT =
  "doc_sync.version_seed_failed";

/** Below the API client's delete timeout (PLN-2200 T-5.2), so the service answers first. */
export const DELETE_UNLOAD_DEADLINE_MS = 5000;

export const CommandOutcome = {
  Done: "done",
  Deleted: "deleted",
  NotFound: "not_found",
  AnchorRefused: "anchor_refused",
  UnloadTimeout: "unload_timeout",
  Seeded: "seeded",
  SeedFailed: "seed_failed",
} as const;

/** A tombstoned document: every per-document command answers this, except delete. */
export type DocumentDeleted = { kind: typeof CommandOutcome.Deleted };

export type ClearResult =
  | { kind: typeof CommandOutcome.Done; cleared: boolean }
  | DocumentDeleted;

export type AnchorRefusalCode =
  | typeof DocSyncInternalErrorCode.AnchorNotFound
  | typeof DocSyncInternalErrorCode.AnchorAmbiguous;

export type CommentAnchorResult =
  | { kind: typeof CommandOutcome.Done }
  | {
      kind: typeof CommandOutcome.AnchorRefused;
      code: AnchorRefusalCode;
      matchCount: number;
    }
  | DocumentDeleted;

export type ReadTextResult =
  | { kind: typeof CommandOutcome.Done; text: string }
  | { kind: typeof CommandOutcome.NotFound }
  | DocumentDeleted;

/**
 * `UnloadTimeout` (503 `unload_timeout`) is not a refused delete. The name is
 * tombstoned before the wait starts and stays tombstoned for the tombstone TTL
 * whatever the outcome: every connection is refused, every store is dropped
 * and every other command answers 410, while the stored row is kept. The
 * caller retries the delete; it never rolls the delete back.
 */
export type DeleteResult =
  | { kind: typeof CommandOutcome.Done; deleted: boolean; wasLoaded: boolean }
  | { kind: typeof CommandOutcome.UnloadTimeout };

/**
 * `SeedFailed` is a seed that threw or never ran, already logged as
 * {@link DOC_SYNC_VERSION_SEED_FAILED_EVENT}; `stale` is a seed skipped
 * because the document holds a newer seeded version, or this one outside
 * `Reset` mode.
 */
export type SeedVersionResult =
  | {
      kind: typeof CommandOutcome.Seeded;
      applied: boolean;
      stale: boolean;
      updateBytes: number;
    }
  | { kind: typeof CommandOutcome.SeedFailed }
  | DocumentDeleted;

/** The service commands `/internal/documents/*` serves. Each takes a canonical name the route has checked. */
export type DocSyncCommands = {
  seedVersion: (
    documentName: string,
    request: SeedVersionRequest
  ) => Promise<SeedVersionResult>;
  probeFirstOpenSeed: (
    documentName: string
  ) => Promise<FirstOpenSeedProbeResult>;
  seedIfNeverStored: (
    documentName: string,
    request: SeedIfNeverStoredRequest
  ) => Promise<SeedIfNeverStoredResult>;
  clear: (documentName: string) => Promise<ClearResult>;
  addCommentAnchor: (
    documentName: string,
    request: CommentAnchorRequest
  ) => Promise<CommentAnchorResult>;
  readText: (documentName: string) => Promise<ReadTextResult>;
  deleteDocument: (documentName: string) => Promise<DeleteResult>;
  listNames: (
    after: string | undefined,
    limit: number
  ) => Promise<ListDocumentsResponse>;
};

export type DocumentCommands = {
  commands: DocSyncCommands;
  /** Called by the server's `afterUnloadDocument` hook. */
  documentUnloaded: (documentName: string) => void;
};

export type DocumentCommandDeps = {
  hocuspocus: Pick<
    Hocuspocus,
    | "documents"
    | "loadingDocuments"
    | "unloadingDocuments"
    | "closeConnections"
    | "unloadDocument"
    | "openDirectConnection"
    | "debouncer"
  >;
  /** The server's tombstone-aware storage. */
  storage: DocumentStorage;
  tombstones: Tombstones;
  neverStored: Pick<NeverStoredTracker, "has">;
  unloadDeadlineMs?: number;
  now?: () => number;
};

export function createDocumentCommands({
  hocuspocus,
  storage,
  tombstones,
  neverStored,
  unloadDeadlineMs = DELETE_UNLOAD_DEADLINE_MS,
  now = Date.now,
}: DocumentCommandDeps): DocumentCommands {
  /** Bounded by concurrent deletes: a waiter leaves when it resolves or times out. */
  const unloadWaiters = new Map<string, Set<() => void>>();
  const timed = commandTimer(now);
  const firstOpenSeed = { hocuspocus, storage, neverStored };

  /**
   * The tombstone gate every per-document command but delete runs behind,
   * checked again once `work` settles: a delete landing during its storage
   * read or direct connection would otherwise answer for an empty load.
   */
  const unlessDeleted =
    <T>(documentName: string, work: () => Promise<T>) =>
    async (): Promise<T | DocumentDeleted> => {
      if (tombstones.has(documentName)) {
        return DELETED;
      }
      const result = await work();
      return tombstones.has(documentName) ? DELETED : result;
    };

  /** Live or loading in memory, or stored: anything a direct connection would not create. */
  const hasState = async (documentName: string) =>
    hocuspocus.documents.has(documentName) ||
    hocuspocus.loadingDocuments.has(documentName) ||
    (await storage.exists(documentName));

  const waitForUnload = (
    documentName: string,
    document: Document
  ): Promise<boolean> => {
    const { promise, cancel } = unloadWaiter(unloadWaiters, documentName);
    const storeId = `onStoreDocument-${documentName}`;
    // A pending store would hold the document loaded; tombstoned, it stores nothing.
    Promise.resolve(hocuspocus.debouncer.executeNow(storeId)).catch(
      () => undefined
    );
    hocuspocus.unloadDocument(document).catch(() => undefined);
    return raceDeadline(promise, unloadDeadlineMs, cancel);
  };

  const commands: DocSyncCommands = {
    // Unlike clear and anchor, a seed loads a never-stored document: the
    // version row is the source of truth the live document converges on.
    seedVersion: (documentName, request) =>
      timed(
        CommandName.SeedVersion,
        documentName,
        unlessDeleted(documentName, () =>
          seedVersion(hocuspocus, documentName, request)
        ),
        (result) => seedLogFields(result, request.version)
      ),

    // ISS-12508: neither the first-open probe nor its apply ever logs the
    // markdown.
    probeFirstOpenSeed: (documentName) =>
      timed(
        CommandName.FirstOpenSeed,
        documentName,
        unlessDeleted(documentName, async () => ({
          kind: CommandOutcome.Done,
          state: await firstOpenSeedState(firstOpenSeed, documentName),
        })),
        (result): Record<string, string> =>
          result.kind === CommandOutcome.Done ? { state: result.state } : {}
      ),

    seedIfNeverStored: (documentName, request) =>
      timed(
        CommandName.SeedIfNeverStored,
        documentName,
        unlessDeleted(documentName, () =>
          applyFirstOpenSeed(firstOpenSeed, documentName, request).then(
            (seeded): SeedIfNeverStoredResult => ({
              kind: CommandOutcome.Done,
              ...seeded,
            }),
            (error: unknown) =>
              seedFailed(
                CommandName.SeedIfNeverStored,
                documentName,
                request.version,
                error
              )
          )
        ),
        (result) => firstOpenSeedLogFields(result, request.version)
      ),

    clear: (documentName) =>
      timed(
        CommandName.Clear,
        documentName,
        unlessDeleted(documentName, async (): Promise<ClearResult> => {
          if (!(await hasState(documentName))) {
            return { kind: CommandOutcome.Done, cleared: false };
          }
          await withDirectConnection(
            hocuspocus,
            documentName,
            DocSyncChangeSource.Clear,
            (document) => {
              const fragment = document.getXmlFragment(DOCUMENT_FRAGMENT_FIELD);
              fragment.delete(0, fragment.length);
            }
          );
          return { kind: CommandOutcome.Done, cleared: true };
        })
      ),

    addCommentAnchor: (documentName, { threadId, anchorText }) =>
      timed(
        CommandName.CommentAnchor,
        documentName,
        unlessDeleted(documentName, async (): Promise<CommentAnchorResult> => {
          if (!(await hasState(documentName))) {
            return anchorRefusal({ kind: AnchorKind.NotFound });
          }
          const location = await withDirectConnection(
            hocuspocus,
            documentName,
            DocSyncChangeSource.CommentAnchor,
            (document) => {
              // One instance at launch (PLN-2099 E2): the check and the mark land in one synchronous turn.
              const found = locateAnchor(
                document.getXmlFragment(DOCUMENT_FRAGMENT_FIELD),
                anchorText
              );
              if (found.kind === AnchorKind.Unique) {
                applyCommentMark(found.match, anchorText, threadId);
              }
              return found;
            }
          );
          return location.kind === AnchorKind.Unique
            ? { kind: CommandOutcome.Done }
            : anchorRefusal(location);
        })
      ),

    readText: (documentName) =>
      timed(
        CommandName.Text,
        documentName,
        unlessDeleted(documentName, async (): Promise<ReadTextResult> => {
          const loaded = hocuspocus.documents.get(documentName);
          if (loaded) {
            // No direct connection: its disconnect would store.
            return {
              kind: CommandOutcome.Done,
              text: fragmentPlainText(
                loaded.getXmlFragment(DOCUMENT_FRAGMENT_FIELD)
              ),
            };
          }
          const stored = await storage.fetch(documentName);
          if (stored === null) {
            return { kind: CommandOutcome.NotFound };
          }
          return { kind: CommandOutcome.Done, text: storedPlainText(stored) };
        })
      ),

    deleteDocument: (documentName) =>
      timed(
        CommandName.Delete,
        documentName,
        async (): Promise<DeleteResult> => {
          tombstones.add(documentName);
          hocuspocus.closeConnections(documentName);
          const loading = hocuspocus.loadingDocuments.get(documentName);
          if (loading) {
            await loading.catch(() => undefined);
            // A connection admitted before the tombstone attaches once its load ends.
            hocuspocus.closeConnections(documentName);
          }
          const document = hocuspocus.documents.get(documentName);
          const wasLoaded = loading !== undefined || document !== undefined;
          if (document && !(await waitForUnload(documentName, document))) {
            log.error("Doc sync delete timed out waiting for unload", {
              event: DOC_SYNC_DELETE_UNLOAD_TIMEOUT_EVENT,
              documentName,
              unloadDeadlineMs,
            });
            return { kind: CommandOutcome.UnloadTimeout };
          }
          await hocuspocus.unloadingDocuments.get(documentName);
          const deleted = await storage.delete(documentName);
          return { kind: CommandOutcome.Done, deleted, wasLoaded };
        }
      ),

    listNames: async (after, limit) => {
      const names = await storage.listNames(after, limit);
      return {
        names,
        nextAfter: names.length === limit ? (names.at(-1) ?? null) : null,
      };
    },
  };

  return {
    commands,
    documentUnloaded: (documentName) => {
      const waiters = unloadWaiters.get(documentName);
      unloadWaiters.delete(documentName);
      for (const resolve of waiters ?? []) {
        resolve();
      }
    },
  };
}

const DELETED: DocumentDeleted = { kind: CommandOutcome.Deleted };

/**
 * Parses `markdown` the way the editor does and applies it as a diff on a
 * direct connection, whose disconnect stores it.
 */
async function seedVersion(
  hocuspocus: DocumentCommandDeps["hocuspocus"],
  documentName: string,
  { markdown, version, mode }: SeedVersionRequest
): Promise<SeedVersionResult> {
  try {
    const content = markdownToDocument(markdown);
    const connection = await hocuspocus.openDirectConnection(documentName, {
      source: DocSyncChangeSource.SeedVersion,
      version,
    });
    try {
      const { document } = connection;
      if (!document) {
        throw new Error("The direct connection closed before the seed ran");
      }
      const { applied, updateBytes } = await measuredSeed(
        document,
        (edit) => connection.transact(edit),
        (live) => applyVersionSeed(live, content, version, mode).applied
      );
      return {
        kind: CommandOutcome.Seeded,
        applied,
        stale: !applied,
        updateBytes,
      };
    } finally {
      await connection.disconnect();
    }
  } catch (error) {
    return seedFailed(CommandName.SeedVersion, documentName, version, error);
  }
}

function seedFailed(
  command: CommandName,
  documentName: string,
  version: number,
  error: unknown
): { kind: typeof CommandOutcome.SeedFailed } {
  log.error("Doc sync version seed failed", {
    event: DOC_SYNC_VERSION_SEED_FAILED_EVENT,
    command,
    documentName,
    version,
    code: errorCode(error),
  });
  return { kind: CommandOutcome.SeedFailed };
}

const SeedLogOutcome = {
  Applied: "applied",
  Stale: "stale",
  Skipped: "skipped",
} as const;

function seedLogFields(
  result: SeedVersionResult,
  version: number
): Record<string, string | number> {
  if (result.kind !== CommandOutcome.Seeded) {
    return { version };
  }
  return {
    outcome: result.applied ? SeedLogOutcome.Applied : SeedLogOutcome.Stale,
    version,
    updateBytes: result.updateBytes,
  };
}

function firstOpenSeedLogFields(
  result: SeedIfNeverStoredResult,
  version: number
): Record<string, string | number> {
  if (result.kind !== CommandOutcome.Done) {
    return { version };
  }
  return {
    outcome: result.applied ? SeedLogOutcome.Applied : SeedLogOutcome.Skipped,
    version,
    updateBytes: result.updateBytes,
  };
}

function anchorRefusal(
  location: Exclude<AnchorLocation, { kind: typeof AnchorKind.Unique }>
): CommentAnchorResult {
  return location.kind === AnchorKind.Ambiguous
    ? {
        kind: CommandOutcome.AnchorRefused,
        code: DocSyncInternalErrorCode.AnchorAmbiguous,
        matchCount: location.matchCount,
      }
    : {
        kind: CommandOutcome.AnchorRefused,
        code: DocSyncInternalErrorCode.AnchorNotFound,
        matchCount: 0,
      };
}
