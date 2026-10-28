import type { Document, onStoreDocumentPayload } from "@hocuspocus/server";

/**
 * Runs `store`; when it fails, schedules the document's next store on
 * Hocuspocus's own store debouncer before rethrowing. Hocuspocus schedules
 * nothing after a failed store, so without this the document unloads as soon
 * as its last connection closes and the edits only it holds are lost. A
 * pending store keeps `shouldUnloadDocument` false, so the document stays
 * loaded until a store succeeds, and shutdown's `flushPendingStores` runs the
 * pending retry at once.
 */
export async function storeOrRetryLater(
  payload: onStoreDocumentPayload,
  store: () => Promise<void>
): Promise<void> {
  const { document, instance } = payload;
  try {
    await store();
    failedStores.delete(document);
  } catch (error) {
    const failures = (failedStores.get(document) ?? 0) + 1;
    failedStores.set(document, failures);
    // Hocuspocus 4.7.0's id for a document's store, which `shouldUnloadDocument`
    // and `flushPendingStores` read. A store already pending (a newer edit's)
    // is the retry.
    const debounceId = `onStoreDocument-${document.name}`;
    if (!instance.debouncer.isDebounced(debounceId)) {
      const delayMs = retryDelayMs(failures);
      instance.debouncer
        .debounce(
          debounceId,
          () => instance.storeDocumentHooks(document, payload, true),
          delayMs,
          delayMs
        )
        .catch(() => undefined);
    }
    throw error;
  }
}

/** Keyed by the loaded document, so an unloaded one takes its count with it. */
const failedStores = new WeakMap<Document, number>();

/** The wait before each retry of a document whose store failed; the last one repeats. */
const RETRY_DELAYS_MS: readonly number[] = [
  1000, 2000, 4000, 8000, 16_000, 30_000,
];

function retryDelayMs(failures: number): number {
  return RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1] ?? 0;
}
