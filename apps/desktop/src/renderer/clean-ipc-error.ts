/**
 * Electron wraps every rejection that crosses `ipcRenderer.invoke` in a
 * synthetic error whose message names the internal IPC channel, e.g.
 *
 *   Error invoking remote method 'desktop:set-api-key': Error: API key must start with sk_live_
 *
 * Surfacing that string verbatim leaks the private channel name to the user and
 * doubles the `Error:` prefix. `cleanIpcError` strips the wrapper and the
 * redundant prefix so only the underlying human-facing message remains.
 */

// Matches Electron's leading `Error invoking remote method '<channel>': `
// wrapper. The channel name is non-greedy so a message that itself contains a
// single-quote does not over-consume.
const IPC_WRAPPER_PREFIX = /^Error invoking remote method '[^']*':\s*/;

// Matches one or more leading `Error:` prefixes (with surrounding whitespace),
// so `Error: Error: boom` collapses to `boom`. Electron re-serializes the
// remote error's `.toString()`, which prepends its own `Error:`; after the
// wrapper is stripped we may be left with one or two of these.
const LEADING_ERROR_PREFIX = /^(?:Error:\s*)+/;

/**
 * Given an unknown caught value, return a clean, user-facing message string.
 *
 * - Strips Electron's `Error invoking remote method '<channel>': ` IPC wrapper.
 * - Collapses redundant leading `Error:` prefixes to nothing.
 * - Falls back to `fallback` for non-Error values (or when the cleaned message
 *   is empty), mirroring the previous inline
 *   `err instanceof Error ? err.message : fallback` pattern.
 *
 * Pure and side-effect free.
 */
export function cleanIpcError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : "";
  const cleaned = raw
    .replace(IPC_WRAPPER_PREFIX, "")
    .replace(LEADING_ERROR_PREFIX, "")
    .trim();
  return cleaned || fallback;
}

/**
 * Read a canonical boolean readback field from an IPC setter's resolved value.
 *
 * The cloud-control setters resolve with the post-apply state read back from
 * the source of truth (e.g. `{ paused: true }`, `{ enabled: false }`), which
 * the renderer must trust over the requested value so a requested/actual
 * mismatch is reflected rather than the request. Older desktop builds resolve
 * without the readback (an unknown/`undefined`/`void` shape), so a non-boolean
 * field degrades to `fallback` (the requested value) for cross-repo skew.
 */
export function readBooleanField(
  result: unknown,
  field: string,
  fallback: boolean
): boolean {
  if (result && typeof result === "object") {
    const value = (result as Record<string, unknown>)[field];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return fallback;
}
