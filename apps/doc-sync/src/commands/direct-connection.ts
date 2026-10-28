import type { Document, Hocuspocus } from "@hocuspocus/server";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { fragmentPlainText } from "@repo/document-schema/comment-anchor";
import type { DocSyncChangeSource } from "@repo/realtime-contract/doc-sync-internal";
import { applyUpdate, Doc } from "yjs";

/**
 * Edits in one transaction through a direct connection, whose disconnect
 * stores the change as any edit is stored.
 */
export async function withDirectConnection<T>(
  hocuspocus: Pick<Hocuspocus, "openDirectConnection">,
  documentName: string,
  source: DocSyncChangeSource,
  edit: (document: Document) => T
): Promise<T> {
  const connection = await hocuspocus.openDirectConnection(documentName, {
    source,
  });
  const box: { result?: { value: T } } = {};
  try {
    await connection.transact((document) => {
      box.result = { value: edit(document) };
    });
  } finally {
    await connection.disconnect();
  }
  if (box.result === undefined) {
    throw new Error("The direct connection closed before the edit ran");
  }
  return box.result.value;
}

export function storedPlainText(state: Uint8Array): string {
  const doc = new Doc({ gc: true });
  try {
    applyUpdate(doc, state);
    return fragmentPlainText(doc.getXmlFragment(DOCUMENT_FRAGMENT_FIELD));
  } finally {
    doc.destroy();
  }
}
