/**
 * @file read-cancellation-contract.ts
 * @description ISS-9802 — the one place the desktop read-cancellation token is
 * defined, shared by every hop it crosses.
 *
 * A superseded desktop read used to stop being AWAITED and keep RUNNING:
 * `readHonoringSignal` checked the renderer's `AbortSignal` either side of the
 * IPC call, and an `AbortSignal` is not structured-cloneable so nothing about
 * the abort reached the work. This module is what does cross: a plain string
 * the renderer mints per read and the store thread can be told to honour.
 *
 * ## What a token can and cannot cancel
 *
 * Cancellation lands at a STATEMENT BOUNDARY and nowhere else. The store thread
 * observes the token at its existing `yieldDbHostLoop()` checkpoints, which sit
 * BETWEEN the aggregate's statements; a statement already executing inside the
 * synchronous libSQL driver cannot be interrupted by anything at this layer. So
 * a cancelled corpus aggregate abandons its REMAINING statements, and the one in
 * flight runs to completion first. Any contract claiming more than that would be
 * the overclaim ISS-9741 was corrected for, in a new place.
 *
 * ISS-10573 narrows that for ONE read: `aggregateSqliteUsage` now checkpoints
 * before its snapshot transaction rather than between the six statements inside
 * it, because a yield inside a Prisma interactive transaction charges whatever
 * op takes the store thread to that transaction's wall-clock budget. Its
 * granularity is therefore the transaction boundary, not the statement boundary.
 * ISS-10606 took the other trade for `aggregateSqliteAnalytics`, the read this
 * token was built for: its breakdowns no longer share one snapshot, so the
 * checkpoints stay between statements. The one exception is the two byRepository
 * statements, which still share a transaction and have no checkpoint between.
 *
 * ## Zero imports, on purpose
 *
 * The renderer, the main process, the db-host dispatcher and the store thread
 * all import this. The store thread's bootstrap (`db-store-worker.ts`) keeps its
 * module graph behind a try/catch, so anything reachable from that side must
 * stay import-free and unable to throw at load.
 */

/**
 * `Error.name` a cancelled store-side read carries back.
 *
 * Serialization across the two process hops keeps `name`/`message` and drops the
 * prototype, so the NAME is the only classifier that survives — which is why it
 * is a shared constant rather than an `instanceof` on either side.
 */
export const READ_CANCELLED_ERROR_NAME = "DesktopReadCancelledError";

/** Message a cancelled read rejects with; stable so a log line is greppable. */
export const READ_CANCELLED_ERROR_MESSAGE =
  "Desktop read cancelled by the caller.";

/**
 * Longest token any hop will accept.
 *
 * A COUNT cap bounds entries, not BYTES, and the registries downstream retain
 * the token string itself — so a caller sending 64 megabyte-long tokens stays
 * inside a 64-entry ring and still pins unbounded memory on the store thread.
 * The length cap is what makes that ring's bound a real one.
 *
 * Generous against the real minter by two orders of magnitude:
 * `nextReadCancellationToken` emits `<base36 ms>-<8 chars>-<counter>`, ~25
 * characters, so no token this repo produces can approach the cap.
 */
export const READ_CANCELLATION_TOKEN_MAX_LENGTH = 128;

/**
 * A token is a non-empty, LENGTH-BOUNDED string and nothing else.
 *
 * Both hops below it re-validate rather than trust their caller: `args` and the
 * request payload crossed a structured clone and an `ipcRenderer.invoke`, so
 * types constrain neither at runtime. An unusable token is treated as ABSENT —
 * the read runs exactly as it does today — never as an error, because a
 * malformed cancellation must not cost the caller its answer. That is also why
 * an over-long token degrades rather than throwing: a peer minting longer
 * tokens than this one expects loses cancellation, never its answer.
 */
export function isReadCancellationToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= READ_CANCELLATION_TOKEN_MAX_LENGTH
  );
}

/**
 * Read a cancellation token off an untrusted IPC payload.
 *
 * The renderer attaches the token to the read REQUEST under this one key, and
 * main reads it back with this one function, so the two cannot disagree about
 * where it lives. The request schema (`shared-agent-sessions-contract-schema.ts`)
 * does not model the key and therefore STRIPS it before the filters reach
 * `sanitizeQuery` — which is the intended split: the token is transport
 * metadata, never a filter, and an older main that has never heard of it strips
 * it in exactly the same way.
 */
export function readCancellationTokenOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return;
  }
  const token = (payload as { cancellationToken?: unknown }).cancellationToken;
  return isReadCancellationToken(token) ? token : undefined;
}

/** True for the rejection a store-side cancellation produces, after any hop. */
export function isReadCancelledError(error: unknown): boolean {
  return error instanceof Error && error.name === READ_CANCELLED_ERROR_NAME;
}

/**
 * Discriminator for {@link DesktopReadCancelledResult}. Namespaced so it cannot
 * collide with a real payload field on any read channel.
 */
export const DESKTOP_READ_CANCELLED_STATUS =
  "desktop:read-cancellation:cancelled";

/**
 * The typed "no answer — you cancelled this read" result an ipcMain read handler
 * resolves with instead of rejecting. Deliberately payload-free.
 *
 * The same reasoning as ISS-5262's shutdown sentinel, for the same reason:
 * `ipcMain.handle` prints `Error occurred in handler for '<channel>'` for ANY
 * rejection, so without this every ordinary user abort — a panel switch, an
 * unmount — would log a handler error for something that is not a failure. And
 * it must not resolve with DATA: an empty analytics aggregate is
 * indistinguishable from a real one, and a `0` token/cost total is exactly the
 * plausible-but-wrong number the repo forbids. The read never finished, so the
 * honest answer is "unknown", not "zero".
 *
 * The renderer never sees it: the preload turns it back into a rejection, which
 * the local data source then reports as the caller's own cancellation.
 */
export type DesktopReadCancelledResult = {
  readonly status: typeof DESKTOP_READ_CANCELLED_STATUS;
};

/** The single shared instance; frozen so no caller can graft a payload onto it. */
export const DESKTOP_READ_CANCELLED_RESULT: DesktopReadCancelledResult =
  Object.freeze({
    status: DESKTOP_READ_CANCELLED_STATUS,
  });

/** Message the preload uses when it converts the sentinel back to a rejection. */
export const DESKTOP_READ_CANCELLED_MESSAGE =
  "desktop read cancelled by the caller; read abandoned";

/**
 * Recognize the sentinel in an IPC result.
 *
 * Structural rather than referential: the value crossed a structured-clone
 * boundary, so it is a copy, never {@link DESKTOP_READ_CANCELLED_RESULT} itself.
 */
export function isDesktopReadCancelledResult(
  value: unknown
): value is DesktopReadCancelledResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === DESKTOP_READ_CANCELLED_STATUS
  );
}

/**
 * Pass a real result through; turn the cancellation sentinel into a rejection.
 *
 * Applied by the preload beside `rejectIfDbHostShuttingDown`, and centralized
 * for the same reason: the bridges cast the IPC result, so a sentinel that
 * slipped past would typecheck as `T` and reach the renderer as data.
 */
export function rejectIfReadCancelled<TResult>(
  value: TResult | DesktopReadCancelledResult
): TResult {
  if (isDesktopReadCancelledResult(value)) {
    throw new Error(DESKTOP_READ_CANCELLED_MESSAGE);
  }
  return value as TResult;
}

/** The rejection a cancelled store-side read produces. */
export class DesktopReadCancelledError extends Error {
  constructor() {
    super(READ_CANCELLED_ERROR_MESSAGE);
    this.name = READ_CANCELLED_ERROR_NAME;
  }
}
