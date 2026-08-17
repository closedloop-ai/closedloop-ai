/**
 * @file agent-session-sync-component-test-utils.ts
 * @description Shared test helpers for the component-inventory sync lane specs.
 * `syncedFor` and `flush` were verbatim duplicates across the keyset-cursor and
 * single-flight tests; extracted here so both import one copy (FEA-3448 review).
 */

import {
  ComponentSyncSendOutcome,
  type ComponentSyncSendResult,
} from "../src/main/agent-sync/agent-component-sync-dead-letter.js";

/**
 * A `SyncedComponent`-shaped row for the component lane fakes: `id` doubles as
 * the external id + component key, and `lastSeenAt` is mirrored into
 * `firstSeenAt`/`lastSeenAt` so the injected loader returns a stable shape.
 */
export function syncedFor(id: string, lastSeenAt: string | null) {
  return {
    externalId: id,
    componentKind: "mcp",
    componentKey: id,
    harness: null,
    name: null,
    version: null,
    description: null,
    sourceUrl: null,
    installPath: null,
    packId: null,
    scope: null,
    projectPath: null,
    metadata: null,
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    uninstalledAt: null,
  };
}

/** Flush queued microtasks/immediates so the async component lane settles. */
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * ISS-4542: build a {@link ComponentSyncSendResult} for the component-lane fakes.
 * The `sendComponents` transport now resolves a classified result, not a bare
 * boolean; these helpers keep the specs pinned to the real contract. Use
 * `sendResultFor(accepted)` in the common poison-vs-good mocks: an accepted send
 * is `Accepted`, and a rejected one is `BatchRejected` (a PERMANENT per-batch
 * rejection — the only class that charges the dead-letter budget), which is what
 * the "poison 403 that never clears" fixtures model.
 */
export function acceptedResult(): ComponentSyncSendResult {
  return {
    outcome: ComponentSyncSendOutcome.Accepted,
    firstUnsentChunkIndex: null,
    chunkCount: 1,
  };
}

export function batchRejectedResult(): ComponentSyncSendResult {
  return {
    outcome: ComponentSyncSendOutcome.BatchRejected,
    firstUnsentChunkIndex: 0,
    chunkCount: 1,
  };
}

export function laneFailureResult(): ComponentSyncSendResult {
  return {
    outcome: ComponentSyncSendOutcome.LaneFailure,
    firstUnsentChunkIndex: 0,
    chunkCount: 1,
  };
}

/** Map the legacy accepted-boolean fixture semantics onto the classified result:
 * `true` → `Accepted`, `false` → `BatchRejected` (permanent per-batch rejection). */
export function sendResultFor(accepted: boolean): ComponentSyncSendResult {
  return accepted ? acceptedResult() : batchRejectedResult();
}
