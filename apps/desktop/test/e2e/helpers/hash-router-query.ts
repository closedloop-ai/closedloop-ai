/**
 * Reading the renderer's list params out of a driven page URL.
 *
 * Its own module rather than a copy per spec: the trap below is the whole
 * reason the helper exists, and a second copy is one docstring away from being
 * rewritten as the vacuous version (AGENTS.md — extract a shared helper rather
 * than duplicate one).
 *
 * `@repo/*`-free because nothing here needs a shared symbol: it touches only the
 * WHATWG `URL`/`URLSearchParams` globals.
 */

/**
 * The renderer runs on a HASH router, so the list params live after the `#`,
 * not in `location.search`. Reading `new URL(…).searchParams` here would return
 * an always-empty set and every param assertion would pass vacuously.
 */
export function hashQuery(url: string): URLSearchParams {
  const hash = new URL(url).hash;
  const queryStart = hash.indexOf("?");
  return new URLSearchParams(
    queryStart === -1 ? "" : hash.slice(queryStart + 1)
  );
}
