import type { Extension } from "@hocuspocus/server";
import { log } from "@repo/observability/log";
import type { DocSyncCallbackConfig } from "../env";
import type { Tombstones } from "../storage/tombstones";
import { type CallbackSigner, createCallbackSender } from "./callback-sender";
import { changeCallbackExtension } from "./change-callback-extension";
import { createChangeCallbackQueue } from "./change-callback-queue";
import { createChangeLedger } from "./change-ledger";
import { createStsCallerIdentitySigner } from "./sts-signer";

export const DOC_SYNC_CALLBACKS_NOT_CONFIGURED_EVENT =
  "doc_sync.callbacks_not_configured";

/**
 * The change-callback extension and its queue's flush when `config` is set;
 * otherwise neither, logged once at warn. `sign` defaults to the STS
 * caller-identity signer (Q-001 default A).
 */
export function changeCallbacksFor(
  config: DocSyncCallbackConfig | undefined,
  { tombstones, sign }: { tombstones: Tombstones; sign?: CallbackSigner }
):
  | { extension: Extension; flush: (deadlineMs: number) => Promise<void> }
  | undefined {
  if (config === undefined) {
    log.warn(
      "Doc sync change callbacks are off: DOC_SYNC_CALLBACK_URL is unset",
      {
        event: DOC_SYNC_CALLBACKS_NOT_CONFIGURED_EVENT,
      }
    );
    return;
  }
  const queue = createChangeCallbackQueue({
    send: createCallbackSender({
      url: config.url,
      sign: sign ?? createStsCallerIdentitySigner({ region: config.region }),
    }),
  });
  return {
    extension: changeCallbackExtension({
      ledger: createChangeLedger(),
      queue,
      tombstones,
    }),
    flush: (deadlineMs) => queue.flush(deadlineMs),
  };
}
