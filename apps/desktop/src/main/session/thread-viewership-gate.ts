/**
 * @file thread-viewership-gate.ts
 * @description ISS-7830 — the main-process resolver for the
 * `threadViewershipSignal` Labs flag.
 *
 * Mirrors `local-session-pr-gate.ts`, and mirrors WHERE it is read for the same
 * reason. That gate is consulted from `local-session-pull-requests.ts`, which
 * runs in Electron main — the process the composition root registers the
 * resolver in. A module-level singleton cannot cross a process boundary: the
 * db-host runs in its own utility process with its own module registry and never
 * imports the composition root, so a gate read from `sync-source.ts` (which
 * executes in that child) would see the `false` default forever and the toggle
 * could never turn anything on.
 *
 * So this is read at the CAPTURE, in the IPC handler, which is main-side. That
 * placement is also what keeps every flag state honest: with the flag off no row
 * is ever written, so the local classification, the corpus, and the cloud all
 * stay exactly as they were — rather than a recorded-but-suppressed population
 * that would go stale on the cloud the moment someone flipped the toggle.
 *
 * Fails CLOSED: until the composition root registers a resolver — and in every
 * fake, legacy caller and test that never does — this reads `false`, which is the
 * flag's registry default and today's ungated behavior.
 */

/** The registered resolver. Replaced once, by the composition root. */
let resolveGate: () => boolean = () => false;

/**
 * Bind the gate to the real settings store. Called once from the desktop
 * composition root; a later call replaces the previous resolver (the store is a
 * singleton, so this only happens across a full service rebuild).
 */
export function setThreadViewershipSignalResolver(
  resolver: () => boolean
): void {
  resolveGate = resolver;
}

/**
 * Whether this device may record that a user opened a thread. Never throws into
 * the capture: a resolver that fails is treated as OFF (today's behavior) rather
 * than rejecting an IPC call on a screen the user opened to read something else.
 */
export function isThreadViewershipSignalEnabled(): boolean {
  try {
    return resolveGate();
  } catch {
    return false;
  }
}
