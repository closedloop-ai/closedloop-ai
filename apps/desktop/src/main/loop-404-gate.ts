/**
 * Process-memory gate for Loop API endpoints that have returned 404.
 *
 * Tracks disabled endpoint paths per server URL so callers can skip requests
 * to endpoints that are known to be absent on a given server. The gate resets
 * automatically when the process restarts — there is no persistence.
 */

const disabledEndpoints = new Map<string, Set<string>>();

/**
 * Returns true if the given endpoint path has been marked as disabled for the
 * specified server URL, false otherwise.
 */
export function isEndpointDisabled(
  serverUrl: string,
  endpointPath: string
): boolean {
  return disabledEndpoints.get(serverUrl)?.has(endpointPath) ?? false;
}

/**
 * Marks the given endpoint path as disabled for the specified server URL.
 * Subsequent calls to {@link isEndpointDisabled} with the same arguments will
 * return true for the lifetime of the process.
 */
export function markEndpointDisabled(
  serverUrl: string,
  endpointPath: string
): void {
  let paths = disabledEndpoints.get(serverUrl);
  if (paths === undefined) {
    paths = new Set<string>();
    disabledEndpoints.set(serverUrl, paths);
  }
  paths.add(endpointPath);
}

/**
 * Resets all disabled endpoint state. Exposed for testing only — production
 * code must not call this function. In production the gate resets automatically
 * when the process restarts.
 *
 * @internal
 */
export function resetAllGates(): void {
  disabledEndpoints.clear();
}
