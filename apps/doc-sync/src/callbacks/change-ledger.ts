import { isTransactionOrigin, type onChangePayload } from "@hocuspocus/server";
import {
  DOC_SYNC_CALLBACK_MAX_EDITORS,
  DocSyncChangeSource,
  docSyncCallbackIdSchema,
} from "@repo/realtime-contract/doc-sync-internal";
import { z } from "zod";
import { docSyncConnectionContextSchema } from "../auth/connection-hooks";

/** Who or what changed a document since its last callback, and when. */
export type LedgerEntry = {
  sources: Set<DocSyncChangeSource>;
  /**
   * At most `DOC_SYNC_CALLBACK_MAX_EDITORS`, first come first kept; an id
   * `docSyncCallbackIdSchema` refuses is not kept.
   */
  editorUserIds: Set<string>;
  /** Epoch milliseconds. */
  firstChangedAt: number;
  lastChangedAt: number;
};

export type ChangeLedger = {
  record(
    payload: Pick<
      onChangePayload,
      "documentName" | "transactionOrigin" | "context"
    >
  ): void;
  /** The document's entry, removed from the ledger. */
  take(documentName: string): LedgerEntry | undefined;
  forget(documentName: string): void;
};

/**
 * PLN-2200 T-7.2. A change from a client connection records `connection` and
 * the connection's user; one from a command's direct connection records the
 * command's source. A change from any other origin records nothing, so it
 * sends no callback. Entries are keyed by document name and forgotten on
 * unload, so the ledger is bounded by the loaded documents.
 */
// lc-debt: per-process change ledger assumes one instance (PLN-2099 E2); upgrade path: record changes where the shared store lives once doc-sync scales out
export function createChangeLedger({
  now = Date.now,
}: {
  now?: () => number;
} = {}): ChangeLedger {
  const entries = new Map<string, LedgerEntry>();

  return {
    record({ documentName, transactionOrigin, context }) {
      const change = changeOf(transactionOrigin, context);
      if (change === undefined) {
        return;
      }
      const at = now();
      const entry = entries.get(documentName) ?? {
        sources: new Set(),
        editorUserIds: new Set(),
        firstChangedAt: at,
        lastChangedAt: at,
      };
      entry.sources.add(change.source);
      if (
        change.userId !== undefined &&
        entry.editorUserIds.size < DOC_SYNC_CALLBACK_MAX_EDITORS &&
        docSyncCallbackIdSchema.safeParse(change.userId).success
      ) {
        entry.editorUserIds.add(change.userId);
      }
      entry.lastChangedAt = at;
      entries.set(documentName, entry);
    },
    take(documentName) {
      const entry = entries.get(documentName);
      entries.delete(documentName);
      return entry;
    },
    forget(documentName) {
      entries.delete(documentName);
    },
  };
}

function changeOf(
  origin: unknown,
  context: unknown
): { source: DocSyncChangeSource; userId?: string } | undefined {
  if (!isTransactionOrigin(origin)) {
    return;
  }
  if (origin.source === "connection") {
    return {
      source: DocSyncChangeSource.Connection,
      userId: docSyncConnectionContextSchema.safeParse(context).data?.userId,
    };
  }
  if (origin.source === "local") {
    const source = localContextSchema.safeParse(context).data?.source;
    return source === undefined ? undefined : { source };
  }
  return;
}

const localContextSchema = z.object({
  source: z.enum(Object.values(DocSyncChangeSource)),
});

/**
 * Both entries' sources, editors (`older`'s first, still capped) and change
 * window; `undefined` when both are.
 */
export function mergeLedgerEntries(
  older: LedgerEntry | undefined,
  newer: LedgerEntry | undefined
): LedgerEntry | undefined {
  if (older === undefined || newer === undefined) {
    return older ?? newer;
  }
  return {
    sources: new Set([...older.sources, ...newer.sources]),
    editorUserIds: new Set(
      [...new Set([...older.editorUserIds, ...newer.editorUserIds])].slice(
        0,
        DOC_SYNC_CALLBACK_MAX_EDITORS
      )
    ),
    firstChangedAt: Math.min(older.firstChangedAt, newer.firstChangedAt),
    lastChangedAt: Math.max(older.lastChangedAt, newer.lastChangedAt),
  };
}
