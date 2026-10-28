import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { LiveblocksSchemaName } from "@repo/document-schema/liveblocks";
import {
  type DocSyncChangeCallback,
  DocSyncMentionKind,
} from "@repo/realtime-contract/doc-sync-internal";
import { describe, expect, it, vi } from "vitest";
import { Doc, XmlElement } from "yjs";
import { changeCallbackExtension } from "../callbacks/change-callback-extension";
import { createChangeLedger } from "../callbacks/change-ledger";

const DOCUMENT = "org:artifact:PLN-1";

/** What Hocuspocus 4.7.0 passes `onChange` for a client's update. */
function connectionChange(userId: string) {
  const context = { userId, orgId: "org", tokenIssuedAt: 1 };
  return {
    documentName: DOCUMENT,
    transactionOrigin: { source: "connection", connection: { context } },
    context,
  };
}

function mention(doc: Doc, id: string) {
  const node = new XmlElement(LiveblocksSchemaName.Mention);
  node.setAttribute("id", id);
  doc.getXmlFragment(DOCUMENT_FRAGMENT_FIELD).push([node]);
}

function setup() {
  const enqueue = vi.fn<(callback: DocSyncChangeCallback) => void>();
  const extension = changeCallbackExtension({
    ledger: createChangeLedger(),
    queue: { enqueue },
    tombstones: { has: () => false },
  });
  const document = new Doc();
  const payload = { documentName: DOCUMENT, document } as never;
  return {
    enqueue,
    document,
    change: (userId: string) =>
      extension.onChange?.(connectionChange(userId) as never),
    storeStarts: () => extension.onStoreDocument?.(payload),
    storeSucceeds: () => extension.afterStoreDocument?.(payload),
  };
}

describe("changeCallbackExtension", () => {
  it("reports what a store persisted; a change during the write goes in the next store's callback", async () => {
    const { enqueue, document, change, storeStarts, storeSucceeds } = setup();
    await change("user-a");
    await storeStarts();

    mention(document, "user-m");
    await change("user-b");
    await storeSucceeds();
    await storeStarts();
    await storeSucceeds();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      editorUserIds: ["user-a"],
      mentions: [],
    });
    expect(enqueue.mock.calls[1]?.[0]).toMatchObject({
      editorUserIds: ["user-b"],
      mentions: [{ kind: DocSyncMentionKind.User, id: "user-m" }],
    });
  });

  it("carries a failed store's changes into the next successful store's callback", async () => {
    const { enqueue, change, storeStarts, storeSucceeds } = setup();
    await change("user-a");
    // A failed store runs no afterStoreDocument.
    await storeStarts();

    await change("user-b");
    await storeStarts();
    await storeSucceeds();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      editorUserIds: ["user-a", "user-b"],
    });
  });

  it("sends nothing for a store with no change since the last", async () => {
    const { enqueue, change, storeStarts, storeSucceeds } = setup();
    await change("user-a");
    await storeStarts();
    await storeSucceeds();

    await storeStarts();
    await storeSucceeds();

    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
