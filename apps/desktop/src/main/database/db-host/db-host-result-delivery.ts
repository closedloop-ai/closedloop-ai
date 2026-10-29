/**
 * @file db-host-result-delivery.ts
 * @description ISS-12022 — the dispatcher's half of moving a store result to
 * main as bytes. Lives outside `db-host-worker.ts` because that module cannot
 * be imported by a test.
 *
 * A result the store thread encoded reaches here as {@link EncodedDbHostResult}
 * and is posted without being decoded. One larger than
 * {@link DB_HOST_RESULT_PAGE_BYTES} is posted a page at a time, each page only
 * after main pulls it, so the IPC copies in flight are bounded by the page and
 * not by the result. `deliver` resolves once main has pulled the last page, which is
 * what keeps the caller's lane permit spanning the whole transfer.
 */
import {
  type DbHostError,
  type DbHostResponse,
  DbHostResponseKind,
} from "./db-host-protocol.js";
import {
  DB_HOST_RESULT_PAGE_BYTES,
  dbHostResultPage,
  EncodedDbHostResult,
} from "./db-host-result-codec.js";
import { STORE_INVOKE_DEADLINE_MS } from "./db-store-deadlines.js";

export type DbHostResultDeliveryDeps = {
  post: (message: DbHostResponse) => void;
  log: (message: string) => void;
};

export type DbHostResultDelivery = {
  /** Post a successful result for `id`; resolves once main pulled its last page. */
  deliver: (id: number, value: unknown) => Promise<void>;
  /** Answer main's pull for the page of `id` starting at `offset`. */
  pull: (id: number, offset: number) => void;
};

type PagedResult = {
  bytes: ArrayBuffer;
  /** Bytes already posted; the only offset the next pull may name. */
  sent: number;
  timer: ReturnType<typeof setTimeout>;
  done: () => void;
};

export function createDbHostResultDelivery(
  deps: DbHostResultDeliveryDeps
): DbHostResultDelivery {
  const paged = new Map<number, PagedResult>();

  const finish = (id: number, result: PagedResult): void => {
    paged.delete(id);
    clearTimeout(result.timer);
    result.done();
  };

  const fail = (id: number, message: string): void => {
    const error: DbHostError = { message };
    deps.post({ kind: DbHostResponseKind.Result, id, ok: false, error });
  };

  // Main pulls the moment a page lands, so a pull this late is never coming:
  // release the lane rather than hold it, and fail the read rather than hang it.
  const armIdle = (id: number): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      const result = paged.get(id);
      if (!result) {
        return;
      }
      finish(id, result);
      deps.log(
        `db-host result ${id} abandoned after ${STORE_INVOKE_DEADLINE_MS}ms without a page pull (${result.sent} of ${result.bytes.byteLength} bytes sent)`
      );
      fail(id, `db-host result ${id} expired before main pulled it`);
    }, STORE_INVOKE_DEADLINE_MS);

  return {
    deliver(id, value) {
      if (!(value instanceof EncodedDbHostResult)) {
        deps.post({ kind: DbHostResponseKind.Result, id, ok: true, value });
        return Promise.resolve();
      }
      const { bytes } = value;
      if (bytes.byteLength <= DB_HOST_RESULT_PAGE_BYTES) {
        // Not transferred: the insights cache hands one result to every caller.
        deps.post({
          kind: DbHostResponseKind.Result,
          id,
          ok: true,
          encoded: bytes,
        });
        return Promise.resolve();
      }
      const first = dbHostResultPage(bytes, 0);
      deps.post({
        kind: DbHostResponseKind.Result,
        id,
        ok: true,
        encoded: first,
        encodedByteLength: bytes.byteLength,
      });
      return new Promise<void>((resolve) => {
        paged.set(id, {
          bytes,
          sent: first.byteLength,
          timer: armIdle(id),
          done: resolve,
        });
      });
    },

    pull(id, offset) {
      const result = paged.get(id);
      if (!result || offset !== result.sent) {
        if (result) {
          finish(id, result);
        }
        fail(id, `db-host result ${id} has no page at offset ${offset}`);
        return;
      }
      const page = dbHostResultPage(result.bytes, offset);
      result.sent += page.byteLength;
      deps.post({
        kind: DbHostResponseKind.ResultPage,
        id,
        offset,
        encoded: page,
      });
      if (result.sent >= result.bytes.byteLength) {
        finish(id, result);
        return;
      }
      clearTimeout(result.timer);
      result.timer = armIdle(id);
    },
  };
}
