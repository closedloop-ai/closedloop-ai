import { ApiError } from "@repo/app/shared/api/api-error";

/**
 * Run a desktop-local data-source call, converting any thrown/rejected error
 * into a sanitized 500 `ApiError` carrying the given source-specific `code`. The
 * original error is intentionally discarded so no local filesystem/SQL detail
 * leaks to the renderer; throwing `ApiError` (vs a bare `Error`) also makes the
 * shared query client skip the would-be transient-network retry.
 *
 * Shared by every desktop-local `*DataSource` (FEA-1834 agent-sessions, PLN-983
 * branches, …) so the sanitization rule lives in exactly one place instead of
 * being re-copied per source.
 */
export async function runSource<T>(
  run: () => Promise<T>,
  errorMessage: string,
  code: string
): Promise<T> {
  try {
    return await run();
  } catch {
    throw new ApiError(errorMessage, 500, code);
  }
}
