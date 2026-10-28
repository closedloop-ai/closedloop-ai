import { log } from "@repo/observability/log";
import type { RevokeTarget } from "@repo/realtime-contract/internal";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { docSyncInternalClient } from "./internal-client";

/**
 * PLN-2201 T-7.2: asks doc-sync to close `target`'s connections. Never
 * throws, so a revoke never fails the request or webhook that sends it
 * (AC-014); a failure is logged as {@link DOC_SYNC_REVOKE_FAILED_EVENT}, and
 * an unconfigured client does nothing.
 */
export async function revokeDocSyncAccess(target: RevokeTarget): Promise<void> {
  try {
    const result = await docSyncInternalClient().revoke(target);
    if (result.ok || result.failure === InternalCallFailure.NotConfigured) {
      return;
    }
    logRevokeFailed(target, {
      failure: result.failure,
      httpStatus: result.status,
    });
  } catch (error) {
    logRevokeFailed(target, { failure: DOC_SYNC_REVOKE_THREW, error });
  }
}

function logRevokeFailed(
  target: RevokeTarget,
  details: {
    failure: InternalCallFailure | typeof DOC_SYNC_REVOKE_THREW;
    httpStatus?: number;
    error?: unknown;
  }
): void {
  log.error("Doc sync revoke failed", {
    event: DOC_SYNC_REVOKE_FAILED_EVENT,
    target,
    ...details,
  });
}

export const DOC_SYNC_REVOKE_FAILED_EVENT = "doc_sync.revoke_failed";
/** The `failure` logged when the client itself threw, which its contract says it never does. */
export const DOC_SYNC_REVOKE_THREW = "threw";
