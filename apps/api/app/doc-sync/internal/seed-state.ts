import type {
  SeedVersionMode,
  SeedVersionResponse,
} from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import {
  type DocSyncCallResult,
  docSyncInternalClient,
} from "./internal-client";

export type LiveDocumentPublish = {
  document: { organizationId: string; slug: string };
  content: string;
  version: number;
  /** Omitted for a publish; the live-draft reset passes `Reset`. */
  mode?: SeedVersionMode;
};

/**
 * PLN-2190 T-2.2: seeds a published version into the document's live doc-sync
 * state. Never throws: the client resolves every failure, and logs each
 * failed attempt once. A transient failure (unreachable, 429, 5xx) is tried
 * once more; a refusal, an unset service and an invalid request are not.
 * Returns the last attempt's result. A retry after a timed-out attempt that
 * did land is a no-op, since a publish never re-applies its own version.
 */
// lc-debt: no durable retry (PLN-2190 T-2.2); upgrade path: outbox row + cron
export async function publishVersionToLiveDocument({
  document,
  content,
  version,
  mode,
}: LiveDocumentPublish): Promise<DocSyncCallResult<SeedVersionResponse>> {
  const roomId = generateDocumentRoomId(document.organizationId, document.slug);
  const seed = () =>
    docSyncInternalClient().seedVersion(roomId, {
      markdown: content,
      version,
      ...(mode === undefined ? {} : { mode }),
    });
  let result = await seed();
  for (
    let attempt = 1;
    attempt < LIVE_DOCUMENT_SEED_ATTEMPTS && isTransient(result);
    attempt++
  ) {
    result = await seed();
  }
  return result;
}

export const LIVE_DOCUMENT_SEED_ATTEMPTS = 2;

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

function isTransient<T>(result: DocSyncCallResult<T>): boolean {
  if (result.ok) {
    return false;
  }
  if (result.failure === InternalCallFailure.Unreachable) {
    return true;
  }
  return (
    result.failure === InternalCallFailure.Rejected &&
    result.status !== undefined &&
    (result.status === HTTP_TOO_MANY_REQUESTS ||
      result.status >= HTTP_SERVER_ERROR)
  );
}
