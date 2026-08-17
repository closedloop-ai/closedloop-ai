/**
 * ISS-4483 — the db-host PROCESS-LIFECYCLE error signatures, shared between the
 * MAIN process (the db-host worker boundary that sanitizes reads, e.g.
 * `rethrowAsSourceError` in `shared-branches-api.ts`) and the RENDERER
 * (`transient-source-error.ts`, which classifies a settled read error).
 *
 * The local db-host child (a forked utilityProcess) is unstable during
 * first-launch backfill: it can crash-loop / restart mid-request (ISS-4476,
 * ISS-4474, ISS-4410). A request already IN FLIGHT when the child dies rejects
 * with one of these lifecycle strings (see `DbHostClient.handleExit`/`invoke`/
 * `close`). That window is TRANSIENT — the child re-forks on its own — so the
 * read should retry and, at worst, show a quiet "reconnecting" holding state
 * rather than the hard error card.
 *
 * These are process-lifecycle strings, never user/filesystem/SQL data, so
 * matching on them leaks nothing. Owned here (one place) so the main-process
 * sanitizer and the renderer classifier cannot drift on the signature set.
 */
import { findDbHostExitError } from "./db-host-exit-error.js";

// Matched case-insensitively as substrings so an Electron IPC wrapper prefix
// (`Error invoking remote method '<channel>': ...`) that wraps the original
// message still classifies. Deliberately EXCLUDES the generic `"db-host error"`
// fallback (from `rebuildError` when the child reports an operation failure with
// no message): that is a real operation failure, not a restart, so it must stay a
// fatal read that surfaces the hard error + Retry rather than being masked as a
// transient recover.
export const TRANSIENT_DB_HOST_ERROR_SIGNATURES = [
  "db-host exited",
  "db-host is not running",
  "db-host is closed",
] as const;

/**
 * True when `message` carries a db-host restart/lifecycle signature — the
 * transient window in which the read should retry rather than surface a hard
 * error. `null`/empty never matches.
 */
export function isTransientDbHostErrorMessage(
  message: string | null | undefined
): boolean {
  if (!message) {
    return false;
  }
  const haystack = message.toLowerCase();
  return TRANSIENT_DB_HOST_ERROR_SIGNATURES.some((signature) =>
    haystack.includes(signature)
  );
}

/**
 * The raw error's message, for transient-vs-fatal classification ONLY — the
 * main-process source boundaries (`rethrowAsSourceError` in `shared-branches-api`
 * and the usage-half guard in `shared-agent-sessions-api`) inspect it to decide
 * whether a rejection is a db-host lifecycle blip, then discard it. Never surface
 * this to the renderer, which receives only the sanitized code/marker. Owned here
 * beside the signature set so the two boundaries share one extractor.
 */
export function extractDbHostErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return null;
}

/**
 * True when `error` is a db-host lifecycle failure the caller should treat as a
 * TRANSIENT reconnect rather than a fatal read — the MAIN-process form of
 * {@link isTransientDbHostErrorMessage}.
 *
 * ISS-5808: the message form alone cannot answer this. `db-host exited (code: N)`
 * is minted whether or not the supervisor armed a replacement fork, so a message
 * match labelled a permanently-down host "transient" and the Branches page sat in
 * a quiet reconnecting state, retrying, against a host nobody was bringing back.
 * A "transient" label that outlives its own truth is a lie about state.
 *
 * So the TYPED error wins when present: a {@link DbHostExitError} is transient
 * exactly when it says a restart was scheduled, and fatal otherwise. Everything
 * else — an error serialized out of the child, an Electron IPC wrapper prefix,
 * the `db-host is closed` / `db-host is not running` pre-flight rejections —
 * falls back to the message signatures unchanged, so no existing classification
 * moves.
 *
 * The RENDERER keeps using the message form: the typed error never crosses IPC
 * (the source boundaries sanitize it to a code), so there is nothing there to
 * narrow on.
 */
export function isTransientDbHostError(error: unknown): boolean {
  const exit = findDbHostExitError(error);
  if (exit) {
    return exit.restartScheduled;
  }
  return isTransientDbHostErrorMessage(extractDbHostErrorMessage(error));
}
