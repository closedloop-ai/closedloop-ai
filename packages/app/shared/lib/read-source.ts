import type { ReadSource } from "@repo/api/src/types/read-source";

/**
 * FEA-3120: annotate a list envelope with the source the boundary read from,
 * without clobbering a more specific value the backend or IPC layer already
 * set. The default `source` is applied only when the envelope has no
 * `readSource`, so a server (or the desktop IPC layer) that starts reporting
 * `fallback`/`local` stays authoritative.
 *
 * Shared by every read boundary — the HTTP agent-sessions/branches data sources
 * in `@repo/app` and the desktop local-SQLite data sources — so this precedence
 * rule lives in exactly one place and cannot drift across the call sites.
 */
export function withReadSource<T extends { readSource?: ReadSource }>(
  response: T,
  source: ReadSource
): T {
  return response.readSource ? response : { ...response, readSource: source };
}
