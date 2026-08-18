import "server-only";

/**
 * Per-request timeout applied to every GitHub call made through an Octokit
 * built by this package. GitHub's underlying fetch has no default timeout, so
 * a single hung read — e.g. one of the up-to-300 serial blob fetches in
 * `fetchRepoComponents`, or the `repos.get` / `git.getTree` calls alongside
 * it — would otherwise stall the whole request indefinitely with no fail-fast
 * path. Bounding each call lets a hung GitHub dependency fail fast so the
 * caller can retry instead of hanging.
 */
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Wrap `fetch` so each request aborts after GITHUB_REQUEST_TIMEOUT_MS. A
 * fresh timeout signal is minted per call (so every GitHub round-trip is
 * independently bounded) and composed via `AbortSignal.any` with any signal
 * Octokit already supplied, keeping both caller cancellation and the timeout
 * effective.
 */
export function boundedFetch(
  url: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): ReturnType<typeof fetch> {
  const timeoutSignal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...init, signal });
}
