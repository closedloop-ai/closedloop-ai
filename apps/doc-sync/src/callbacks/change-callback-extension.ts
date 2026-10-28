import { randomUUID } from "node:crypto";
import type { Extension } from "@hocuspocus/server";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import {
  DOC_SYNC_CALLBACK_MAX_EDITORS,
  DOC_SYNC_CALLBACK_MAX_MENTIONS,
  type DocSyncMention,
} from "@repo/realtime-contract/doc-sync-internal";
import type { Tombstones } from "../storage/tombstones";
import type { ChangeCallbackQueue } from "./change-callback-queue";
import {
  type ChangeLedger,
  type LedgerEntry,
  mergeLedgerEntries,
} from "./change-ledger";
import { currentMentions } from "./mentions";

/** What a store persists: the changes it covers and the mentions it holds. */
type StoreSnapshot = {
  entry: LedgerEntry;
  mentions: DocSyncMention[];
  truncated: boolean;
};

/**
 * PLN-2200 T-7.5: records each change, and for each successful store enqueues
 * one callback for what that store persisted. `onStoreDocument` snapshots the
 * ledger and the mentions, so it must run before the `Database` extension
 * encodes the state; a change landing during the write goes in the next
 * store's callback (PR #9147 review). A failed store runs no
 * `afterStoreDocument`, so its snapshot carries into the next store's. A
 * deleted document's store is a no-op that still reaches
 * `afterStoreDocument`, so the tombstone is checked there. Wrapped in
 * `guardExtension`.
 */
export function changeCallbackExtension({
  ledger,
  queue,
  tombstones,
}: {
  ledger: ChangeLedger;
  queue: Pick<ChangeCallbackQueue, "enqueue">;
  tombstones: Pick<Tombstones, "has">;
}): Extension {
  const snapshots = new Map<string, StoreSnapshot>();
  const snapshotFailures = new Map<string, unknown>();

  return {
    onChange: (payload) => {
      ledger.record(payload);
      return Promise.resolve();
    },
    // `onStoreDocument` is Propagate: a rejection here fails the store before
    // `storeOrRetryLater` can schedule its retry. A snapshot failure is
    // rethrown from the Contain `afterStoreDocument` instead.
    onStoreDocument: ({ documentName, document }) => {
      try {
        const { mentions, truncated } = currentMentions(
          document.getXmlFragment(DOCUMENT_FRAGMENT_FIELD),
          DOC_SYNC_CALLBACK_MAX_MENTIONS
        );
        const entry = mergeLedgerEntries(
          snapshots.get(documentName)?.entry,
          ledger.take(documentName)
        );
        if (entry !== undefined) {
          snapshots.set(documentName, { entry, mentions, truncated });
        }
      } catch (error) {
        snapshotFailures.set(documentName, error);
      }
      return Promise.resolve();
    },
    afterStoreDocument: ({ documentName }) => {
      if (snapshotFailures.has(documentName)) {
        const failure = snapshotFailures.get(documentName);
        snapshotFailures.delete(documentName);
        return Promise.reject(failure);
      }
      const snapshot = snapshots.get(documentName);
      snapshots.delete(documentName);
      if (snapshot === undefined || tombstones.has(documentName)) {
        return Promise.resolve();
      }
      const { entry, mentions, truncated } = snapshot;
      queue.enqueue({
        callbackId: randomUUID(),
        documentName,
        sources: [...entry.sources],
        editorUserIds: [...entry.editorUserIds].slice(
          0,
          DOC_SYNC_CALLBACK_MAX_EDITORS
        ),
        firstChangedAt: new Date(entry.firstChangedAt).toISOString(),
        lastChangedAt: new Date(entry.lastChangedAt).toISOString(),
        mentions,
        mentionsTruncated: truncated,
      });
      return Promise.resolve();
    },
    afterUnloadDocument: ({ documentName }) => {
      ledger.forget(documentName);
      snapshots.delete(documentName);
      snapshotFailures.delete(documentName);
      return Promise.resolve();
    },
  };
}
