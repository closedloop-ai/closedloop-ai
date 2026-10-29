import { type Document, isTransactionOrigin } from "@hocuspocus/server";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { SeedVersionMode } from "@repo/realtime-contract/doc-sync-internal";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { updateYFragment } from "@tiptap/y-tiptap";
import type { Doc } from "yjs";

/**
 * A top-level map only seed-version writes. Editors never read it: their
 * `Collaboration` extension binds {@link DOCUMENT_FRAGMENT_FIELD} alone.
 */
export const DOC_SYNC_META_MAP = "docSyncMeta";
export const SEEDED_VERSION_KEY = "seededVersion";

/**
 * Applies `content` to the document fragment as a diff, unless the document
 * already holds a newer seeded version. An equal version applies only in
 * `Reset` mode, so a seed of the latest version resets the draft to it while
 * a retried publish is a no-op. Call it inside one transaction, so the check
 * and the write are atomic.
 */
export function applyVersionSeed(
  document: Doc,
  content: ProseMirrorNode,
  version: number,
  mode: SeedVersionMode = SeedVersionMode.Publish
): { applied: boolean } {
  const meta = document.getMap<number>(DOC_SYNC_META_MAP);
  const seededVersion = meta.get(SEEDED_VERSION_KEY);
  if (
    seededVersion !== undefined &&
    (version < seededVersion ||
      (version === seededVersion && mode !== SeedVersionMode.Reset))
  ) {
    return { applied: false };
  }
  updateYFragment(
    document,
    document.getXmlFragment(DOCUMENT_FRAGMENT_FIELD),
    content,
    { mapping: new Map(), isOMark: new Map() }
  );
  if (seededVersion !== version) {
    meta.set(SEEDED_VERSION_KEY, version);
  }
  return { applied: true };
}

/**
 * Undoes every client connection's write to {@link DOC_SYNC_META_MAP}, so the
 * seeded version is only ever one a seed wrote. Nothing else filters client
 * updates: without this, an editor with a write token could raise it and make
 * every later publish skip as stale (PR #8998 review). The revert lands after
 * the client's write, so it wins on every peer.
 */
export function revertClientMetaWrites(document: Doc): void {
  const meta = document.getMap<number>(DOC_SYNC_META_MAP);
  meta.observe((event) => {
    const { origin } = event.transaction;
    if (!(isTransactionOrigin(origin) && origin.source === "connection")) {
      return;
    }
    const changes = [...event.changes.keys];
    document.transact(() => {
      for (const [key, { action, oldValue }] of changes) {
        if (action === "add") {
          meta.delete(key);
        } else {
          meta.set(key, oldValue);
        }
      }
    }, META_REVERT_ORIGIN);
  });
}

const META_REVERT_ORIGIN = { source: "local" } as const;

/**
 * ISS-12508: a first-open seed may apply only to a document `neverStored`
 * says was loaded from an empty fetch and not changed since, whose fragment is
 * empty and which holds no seeded version. Read it inside the seed's
 * transaction, so the check and the write are atomic.
 */
export function isFirstOpenSeedable(
  document: Document,
  neverStored: { has: (documentName: string) => boolean }
): boolean {
  return (
    neverStored.has(document.name) &&
    document.getXmlFragment(DOCUMENT_FRAGMENT_FIELD).length === 0 &&
    document.getMap<number>(DOC_SYNC_META_MAP).get(SEEDED_VERSION_KEY) ===
      undefined
  );
}

export type MeasuredSeed = { applied: boolean; updateBytes: number };

/**
 * Runs `seed` inside `transact`; `updateBytes` sums the document's `update`
 * events during the transaction, so an identical seed counts none. Throws
 * when the transaction never ran.
 */
export async function measuredSeed(
  document: Document,
  transact: (edit: () => void) => unknown,
  seed: (live: Document) => boolean
): Promise<MeasuredSeed> {
  let updateBytes = 0;
  let applied: boolean | undefined;
  const countUpdate = (update: Uint8Array) => {
    updateBytes += update.byteLength;
  };
  document.on("update", countUpdate);
  try {
    await transact(() => {
      applied = seed(document);
    });
  } finally {
    document.off("update", countUpdate);
  }
  if (applied === undefined) {
    throw new Error("The seed's transaction never ran");
  }
  return { applied, updateBytes };
}
