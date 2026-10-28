import {
  DocSyncCount,
  DocSyncHistogram,
  emitDocSyncMetric,
} from "../telemetry/metrics";
import type { DocumentStorage } from "./document-storage";

/**
 * Times every store attempt. `storeOrRetryLater` retries a failed store
 * without limit, and each retry is one attempt here: a resolve samples
 * `doc_sync_store_duration_ms` for that attempt, a rejection counts
 * `doc_sync_store_failures` and rethrows. Every other member is forwarded.
 */
export function instrumentedStorage(
  storage: DocumentStorage,
  now: () => number = () => performance.now()
): DocumentStorage {
  return {
    ...storage,
    store: async (documentName, state) => {
      const startedAt = now();
      try {
        await storage.store(documentName, state);
      } catch (error) {
        emitDocSyncMetric({ metric: DocSyncCount.StoreFailures, count: 1 });
        throw error;
      }
      emitDocSyncMetric({
        metric: DocSyncHistogram.StoreDurationMs,
        value: now() - startedAt,
      });
    },
  };
}
