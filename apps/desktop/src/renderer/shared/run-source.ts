import { ApiError } from "@repo/app/shared/api/api-error";
import {
  isTransientDbHostError,
  TransientSourceError,
} from "./transient-source-error.js";

/**
 * Run a desktop-local data-source call, converting any thrown/rejected error into a
 * sanitized error carrying the given source-specific `code`. The original error is
 * intentionally discarded so no local filesystem/SQL detail leaks to the renderer.
 *
 * ISS-4483 — the sanitized error is now one of two shapes, chosen by classifying
 * the raw failure:
 *   - a TRANSIENT db-host lifecycle failure (the child restarting / crash-looping
 *     mid-backfill, or still importing — see {@link isTransientDbHostError}) becomes
 *     a {@link TransientSourceError}. It is a bare `Error`, so the shared query
 *     client RETRIES it with bounded backoff (a fatal `ApiError` would fail fast),
 *     and it carries a stable transient `code` the renderer routes to the quiet
 *     "reconnecting / still importing" surface instead of the hard error card. The
 *     child re-forks on its own, so most transient reads recover without any UI
 *     breakage.
 *   - every other failure stays a sanitized 500 `ApiError` carrying `code` — a
 *     genuine persistent failure. `ApiError` (vs a bare `Error`) makes the shared
 *     query client skip the would-be transient-network retry, so the hard error +
 *     Retry surfaces immediately for a real breakage.
 *
 * Only the db-host process-lifecycle signatures are matched (never raw error text),
 * so the transient classification preserves the same no-leak contract.
 *
 * Shared by every desktop-local `*DataSource` (FEA-1834 agent-sessions, PLN-983
 * branches, …) so the sanitization rule lives in exactly one place instead of
 * being re-copied per source.
 */
export async function runSource<T>(
  run: () => Promise<T>,
  errorMessage: string,
  code: string,
  transientCode: string
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isTransientDbHostError(error)) {
      throw new TransientSourceError(errorMessage, transientCode);
    }
    throw new ApiError(errorMessage, 500, code);
  }
}
