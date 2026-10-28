import { log } from "@repo/observability/log";
import { errorCode } from "./error-code";

export const STORE_RETRY_EVENT = "doc_sync.store_retry";
export const STORE_FAILED_EVENT = "doc_sync.store_failed";

/** The wait before each retry: the first attempt, then three retries (PLN-2185 AC-005). */
export const STORE_RETRY_DELAYS_MS: readonly number[] = [250, 1000, 4000];

export type StoreWithRetryDeps = {
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Runs `save`, retrying a failure after each of `STORE_RETRY_DELAYS_MS`. Each
 * failed attempt logs `doc_sync.store_retry`; when none is left, logs
 * `doc_sync.store_failed` and rethrows. Logs carry the document name, the
 * attempt, and the error code, never the state.
 */
export async function storeWithRetry(
  save: () => Promise<void>,
  documentName: string,
  { sleep = defaultSleep }: StoreWithRetryDeps = {}
): Promise<void> {
  const attempts = STORE_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await save();
      return;
    } catch (error) {
      const fields = { documentName, attempt, code: errorCode(error) };
      if (attempt >= attempts) {
        log.error("Doc sync store failed", {
          event: STORE_FAILED_EVENT,
          ...fields,
        });
        throw error;
      }
      log.warn("Doc sync store failed; retrying", {
        event: STORE_RETRY_EVENT,
        ...fields,
      });
      await sleep(STORE_RETRY_DELAYS_MS[attempt - 1] ?? 0);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
