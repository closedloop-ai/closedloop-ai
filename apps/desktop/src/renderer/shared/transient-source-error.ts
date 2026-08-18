/**
 * ISS-4483 — transient-vs-fatal classification for desktop-local data-source reads.
 *
 * The local db-host child (a forked utilityProcess) is unstable during first-launch
 * backfill: it can crash-loop / restart mid-request (ISS-4476, ISS-4474, ISS-4410).
 * `DbHostClient` self-heals — a call arriving while the child is down QUEUES on the
 * re-fork — but a request that is already IN FLIGHT when the child dies rejects with
 * a db-host lifecycle error (`db-host exited (code: N)` / `db-host is not running` /
 * `db-host is closed`). That window is TRANSIENT: the child re-forks on its own, so
 * the read should retry (bounded backoff) and, at worst, show a quiet
 * "reconnecting / still importing" holding state — NOT the hard "something went
 * wrong" error card the Sessions list previously fell into on any read failure.
 *
 * This module owns the two seams:
 *   - {@link isTransientDbHostError} matches those lifecycle signatures on the RAW
 *     error inside `runSource` (before the raw message is discarded), classifying it
 *     as transient. The signatures are db-host process-lifecycle strings, never
 *     filesystem/SQL detail, so matching on them leaks nothing.
 *   - {@link TransientSourceError} is the sanitized error `runSource` re-throws for
 *     the transient case. It is a BARE `Error` (not an `ApiError`), so the shared
 *     query client's `isResponseBackedError` returns false and the query RETRIES it
 *     up to `MAX_TRANSIENT_QUERY_RETRIES` with the capped exponential backoff —
 *     exactly the auto-retry the transient window needs — whereas a fatal failure
 *     stays a 500 `ApiError` that fails fast. {@link isTransientSourceError} lets the
 *     renderer route a settled transient error to the reconnecting surface.
 */

import { SHARED_AGENT_COMPONENTS_TRANSIENT_ERROR_CODE } from "../../shared/shared-agent-components-contract.js";
import { SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE } from "../../shared/shared-agent-sessions-contract.js";
import { SHARED_BRANCHES_TRANSIENT_ERROR_CODE } from "../../shared/shared-branches-contract.js";
import { isTransientDbHostErrorMessage } from "../../shared/transient-db-host-error.js";

/**
 * The sanitized, RETRYABLE error thrown for a transient local-source read failure
 * (db-host restarting / still importing). A bare `Error` — deliberately NOT an
 * `ApiError` — so the shared query client does not treat it as response-backed and
 * so retries it with the bounded transient backoff. Carries a stable `code` the
 * renderer reads to route to the quiet reconnecting surface instead of the hard
 * error card. The raw underlying message is never attached, preserving the
 * no-leak contract that `runSource` enforces for fatal failures too.
 *
 * review cid 3679616172 (wongk): the `code` is passed in by the caller, not
 * hardcoded — this class is shared by Sessions, Branches, and Agent Components,
 * each of which carries its OWN source-specific transient code so a settled
 * transient error names the source it came from rather than always claiming to be
 * the agent-sessions transient code.
 */
export class TransientSourceError extends Error {
  readonly name = "TransientSourceError";
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/**
 * True when `error` is a TRANSIENT local-source read failure — the window in which
 * the read should retry rather than surface a hard error. Matches three shapes:
 *   - a `TransientSourceError` already classified upstream (idempotent);
 *   - a raw db-host PROCESS-LIFECYCLE message (`db-host exited` / `db-host is not
 *     running` / `db-host is closed`), the signatures a mid-restart request rejects
 *     with — used on the Sessions path, where the raw message survives IPC;
 *   - a message that IS a known sanitized transient CODE (ISS-4483 review cid
 *     3679616167, wongk): the Branches main-process boundary
 *     (`rethrowAsSourceError`) discards the raw error and rethrows only the
 *     transient code, so the raw "db-host exited" text never reaches here — the
 *     code carries the classification across that sanitizing boundary instead.
 */
export function isTransientDbHostError(error: unknown): boolean {
  if (error instanceof TransientSourceError) {
    return true;
  }
  const message = extractErrorMessage(error);
  return (
    isTransientDbHostErrorMessage(message) ||
    messageCarriesTransientCode(message)
  );
}

/**
 * True when a sanitized transient CODE appears in `message`. A main-process source
 * boundary that discards the raw db-host error (the Branches `rethrowAsSourceError`)
 * rethrows a bare `Error` whose MESSAGE is the transient code, so — unlike the
 * `.code`-property carriers `isTransientSourceError` matches — the classification
 * lives in the message text after crossing IPC. Substring match so an Electron IPC
 * wrapper prefix around the code still classifies.
 */
function messageCarriesTransientCode(message: string | null): boolean {
  if (message === null) {
    return false;
  }
  for (const code of KNOWN_TRANSIENT_ERROR_CODES) {
    if (message.includes(code)) {
      return true;
    }
  }
  return false;
}

/**
 * The source-specific transient codes carried by a settled {@link TransientSourceError}
 * (or an equivalent error rebuilt across the IPC boundary, which loses the
 * prototype). One per local data source — Sessions, Branches, Agent Components —
 * so a settled transient error names the source it came from
 * (review cid 3679616172, wongk).
 */
const KNOWN_TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE,
  SHARED_BRANCHES_TRANSIENT_ERROR_CODE,
  SHARED_AGENT_COMPONENTS_TRANSIENT_ERROR_CODE,
]);

/**
 * Type guard for the sanitized transient error, used by the renderer to route a
 * settled read error to the reconnecting surface (vs the hard error card). Matches:
 *   - a `TransientSourceError` instance;
 *   - any object carrying a known transient `.code` property (an equivalent error
 *     rebuilt across a boundary that loses the prototype but keeps the field);
 *   - an `Error` whose MESSAGE is a known transient code (ISS-4483 review cid
 *     3679616167, wongk): the Branches main-process boundary sanitizes to a bare
 *     `Error(code)` with no `.code` property, so the code arrives in the message.
 * For ANY source's transient code, not just the agent-sessions one.
 */
export function isTransientSourceError(error: unknown): boolean {
  if (error instanceof TransientSourceError) {
    return true;
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    KNOWN_TRANSIENT_ERROR_CODES.has((error as { code: string }).code)
  ) {
    return true;
  }
  return messageCarriesTransientCode(extractErrorMessage(error));
}

function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return null;
}
