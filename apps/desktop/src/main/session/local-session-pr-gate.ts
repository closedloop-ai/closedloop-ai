/**
 * ISS-4922 — the main-process resolver for the `localSessionAuthoredPrGate` Labs
 * flag.
 *
 * `localSessionPullRequests` is a pure leaf reached through `mapListItem` in the
 * 2,000-line `shared-agent-sessions-api.ts`, which owns no settings store and is
 * under a shrink-only size grandfather. Threading a boolean down that path would
 * grow it; instead the composition root registers the store-backed resolver here
 * once at startup and the leaf reads it through a default parameter, so it stays
 * directly testable by passing the flag explicitly.
 *
 * Fails CLOSED: until the composition root registers a resolver — and in every
 * fake/legacy caller and test that never does — the gate reads `false`, which is
 * today's ungated behavior and the flag's registry default.
 */

/** The registered resolver. Replaced once, by the composition root. */
let resolveGate: () => boolean = () => false;

/**
 * Bind the gate to the real settings store. Called once from the desktop
 * composition root; a later call replaces the previous resolver (the store is a
 * singleton, so this only happens across a full service rebuild).
 */
export function setLocalSessionAuthoredPrGateResolver(
  resolver: () => boolean
): void {
  resolveGate = resolver;
}

/**
 * Whether the Local lane should apply the Authored PR gate. Never throws into a
 * list read: a resolver that fails is treated as OFF (today's behavior) rather
 * than collapsing the Sessions list.
 */
export function isLocalSessionAuthoredPrGateEnabled(): boolean {
  try {
    return resolveGate();
  } catch {
    return false;
  }
}
