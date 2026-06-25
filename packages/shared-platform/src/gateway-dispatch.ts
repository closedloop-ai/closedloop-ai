/**
 * Surface-neutral gateway dispatch router + adapter registry.
 *
 * The shared layer owns adapter *selection* only: a registered
 * `SurfaceRoutingAdapter` (web fetch rewrite, desktop IPC, ...) performs the
 * actual transport. This module reads the active routing mode and delegates to
 * the adapter that supports it.
 *
 * Framework-agnostic by contract: no Next.js, no app route constants, no
 * `globalThis.location`, and no browser fetch-interception code. It may read
 * the shared routing store, but callers can also pass an explicit selection
 * (e.g. server-side or tests) so the router never assumes a browser context.
 */

import { getRoutingSelection } from "./routing-store";
import type {
  EngineerRoutingMode,
  RoutingSelection,
  SurfaceRoutingAdapter,
} from "./types";

/**
 * Thrown when no registered adapter supports the active routing mode. Carries
 * the offending mode so callers can surface an actionable message.
 */
export class NoRoutingAdapterError extends Error {
  readonly mode: EngineerRoutingMode;

  constructor(mode: EngineerRoutingMode) {
    super(`No surface routing adapter registered for mode "${mode}"`);
    this.name = "NoRoutingAdapterError";
    this.mode = mode;
  }
}

// Module-level registry. A Set makes registration idempotent: registering the
// same adapter instance twice (e.g. a React Strict Mode double-mount) is a
// no-op rather than a duplicate, and the returned disposer removes exactly the
// instance that was added.
const adapters = new Set<SurfaceRoutingAdapter>();

/**
 * Register a surface adapter. Returns a disposer that unregisters this exact
 * instance -- safe to wire directly into a React effect cleanup.
 */
export function registerSurfaceRoutingAdapter(
  adapter: SurfaceRoutingAdapter
): () => void {
  adapters.add(adapter);
  return () => {
    adapters.delete(adapter);
  };
}

export function unregisterSurfaceRoutingAdapter(
  adapter: SurfaceRoutingAdapter
): void {
  adapters.delete(adapter);
}

export function getRegisteredRoutingAdapters(): SurfaceRoutingAdapter[] {
  return [...adapters];
}

/**
 * First registered adapter that supports `mode`, or `null` if none. Insertion
 * order is preserved (Set iteration order), so the earliest-registered
 * supporting adapter wins.
 */
export function selectRoutingAdapter(
  mode: EngineerRoutingMode
): SurfaceRoutingAdapter | null {
  for (const adapter of adapters) {
    if (adapter.supportsMode(mode)) {
      return adapter;
    }
  }
  return null;
}

/** Test-only: clear the registry between cases. */
export function resetRoutingAdaptersForTests(): void {
  adapters.clear();
}

/**
 * Dispatch a `/api/gateway/*` request through the adapter that supports the
 * active routing mode. `selection` defaults to the shared routing store but may
 * be supplied explicitly (server-side, tests, or to avoid a store read).
 * Rejects with `NoRoutingAdapterError` if no adapter supports the mode.
 */
export async function dispatchGatewayRequest(
  path: string,
  init?: RequestInit,
  selection: RoutingSelection = getRoutingSelection()
): Promise<Response> {
  const adapter = selectRoutingAdapter(selection.mode);
  if (!adapter) {
    throw new NoRoutingAdapterError(selection.mode);
  }
  // `return await` so a rejection from the adapter is surfaced here (and to
  // satisfy the async contract — the no-adapter throw becomes a rejection too).
  return await adapter.dispatchGatewayRequest(path, init);
}
