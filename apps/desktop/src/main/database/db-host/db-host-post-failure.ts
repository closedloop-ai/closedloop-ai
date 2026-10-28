import {
  DbHostDataCloneError,
  type DbHostRequest,
  DbHostRequestKind,
  isPendingCorrelatedRequest,
} from "./db-host-protocol.js";

/**
 * @file db-host-post-failure.ts
 * @description ISS-4620 — what happens when a {@link DbHostRequest} cannot cross
 * the process boundary, extracted from `db-host-client.ts` so that file stays
 * under the size ceiling (ISS-9802 pushed it over).
 *
 * It is a cohesive unit rather than a mechanical slice: both functions below are
 * about ABANDONING work, one request at a time or a whole detached batch, and
 * neither reads any client state beyond the correlation map it is handed.
 */

/** The one thing this module needs from a correlated pending entry. */
type RejectablePending = {
  reject: (error: Error) => void;
};

/**
 * Carry a `postMessage` clone failure to the caller that can act on it.
 *
 * Only requests whose `id` was allocated INTO the pending map (Init, Invoke,
 * Close, and a ResultPagePull for an Invoke's paged result) may be correlated
 * through it. SetUserIdentity has no `id` at all, so it takes the
 * log-and-degrade path, and an un-cloneable identity push or notification can
 * never crash the app.
 */
export function handleDbHostPostFailure(params: {
  request: DbHostRequest;
  error: unknown;
  pending: Map<number, RejectablePending>;
  onLog: (message: string) => void;
}): void {
  const { request, error, pending, onLog } = params;
  const op =
    request.kind === DbHostRequestKind.Invoke ? request.op : request.kind;
  const cloneError = new DbHostDataCloneError(op, error);
  const id = isPendingCorrelatedRequest(request) ? request.id : undefined;
  const correlated = id === undefined ? undefined : pending.get(id);
  if (correlated && id !== undefined) {
    pending.delete(id);
    correlated.reject(cloneError);
    return;
  }
  onLog(cloneError.message);
}

/**
 * ISS-5808 — reject a detached batch of abandoned ops with one error.
 *
 * Takes an ARRAY, not the live pending map, because `handleExit` must detach
 * before it schedules the restart and reject only afterwards: the rejection has
 * to carry whether a replacement child is actually coming, and a consumer's
 * re-drive has to find the new `ready` promise already installed.
 */
export function rejectAll(abandoned: RejectablePending[], error: Error): void {
  for (const pending of abandoned) {
    pending.reject(error);
  }
}
