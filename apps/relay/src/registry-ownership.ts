import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { TelemetryCategory } from "@repo/observability/telemetry/schema";
import type { TargetMetadata, TargetRegistry } from "./target-registry.js";

/**
 * The subset of a live worker this module needs to reason about ownership.
 * Declared structurally rather than imported from `index.ts` so that ownership
 * logic carries no dependency on the relay entrypoint.
 */
type RegistryOwnerCandidate = {
  ownerToken?: string;
};

/**
 * Why a self-heal attempt ended the way it did. The caller only logs, but the
 * distinctions matter when reading relay logs: `NotNeeded` means somebody else
 * legitimately owns the key, while `RolledBack` means we very nearly published
 * a dead target and caught ourselves.
 */
const RegistryHealOutcome = {
  /** A missing entry was re-created for a still-current worker. */
  Healed: "healed",
  /** The worker was already disposed when we looked; nothing was written. */
  SkippedDisposed: "skipped_disposed",
  /** A live entry exists (a newer owner elsewhere); it was left untouched. */
  NotNeeded: "not_needed",
  /** We created an entry, then found the worker had been disposed mid-flight,
   *  so the entry we created was removed again. */
  RolledBack: "rolled_back",
} as const;
type RegistryHealOutcome =
  (typeof RegistryHealOutcome)[keyof typeof RegistryHealOutcome];

type HealMissingRegistryEntryOptions = {
  registry: TargetRegistry;
  targetId: string;
  metadata: TargetMetadata;
  gatewaySessionId?: string;
  /**
   * Synchronous re-check that this worker is STILL the live, connected owner of
   * `targetId` on this instance. Called both before and after the write, so a
   * disposal that lands mid-flight is caught either way.
   */
  isStillCurrentWorker: () => boolean;
};

// Pure ownership decision: is the live local socket still the registry's owner
// for this target? In Redis mode the shared registry is authoritative; a target
// that re-registered on another instance leaves this instance holding a stale
// socket that must not receive dispatches. A null registry entry (in-memory
// miss, degraded Redis, or TTL lapse while connected) trusts the live socket.
export function isCurrentRegistryOwner(
  registered: TargetMetadata | null,
  worker: RegistryOwnerCandidate,
  instanceId: string
): boolean {
  if (!registered) {
    return true;
  }
  return (
    registered.instanceId === instanceId &&
    registered.ownerToken === worker.ownerToken
  );
}

export async function isLocalWorkerCurrentOwner(
  registry: TargetRegistry,
  targetId: string,
  worker: RegistryOwnerCandidate,
  instanceId: string
): Promise<boolean> {
  const registered = await registry.lookup(targetId);
  return isCurrentRegistryOwner(registered, worker, instanceId);
}

/**
 * Re-create a target-registry entry that went missing under a still-live
 * socket.
 *
 * A live socket with no registry entry is invisible to every other relay
 * instance: dispatches landing there answer `target_not_connected` instantly
 * (ISS-5811). `refreshTtl` deliberately refuses to touch a key it cannot prove
 * ownership of, so without this the gap persisted until the desktop
 * reconnected.
 *
 * Two guards keep the repair from becoming the inverse bug — advertising a DEAD
 * target for the full five-minute TTL:
 *
 * 1. `isStillCurrentWorker` is re-checked immediately BEFORE the write, because
 *    the caller reaches here from an async `refreshTtl` continuation and the
 *    socket may have disconnected or been displaced in the meantime.
 * 2. It is re-checked AFTER a successful write, and a disposal that raced us is
 *    undone via `deregister`, which is a compare-and-delete on `ownerToken` and
 *    so can only ever remove the entry THIS call created.
 *
 * The write itself is `SET NX`, so a live entry owned by a newer connection is
 * never clobbered and two instances racing to heal produce exactly one winner.
 * One attempt per heartbeat, never a retry loop.
 */
export async function healMissingRegistryEntry(
  options: HealMissingRegistryEntryOptions
): Promise<RegistryHealOutcome> {
  const {
    registry,
    targetId,
    metadata,
    gatewaySessionId,
    isStillCurrentWorker,
  } = options;

  if (!isStillCurrentWorker()) {
    return RegistryHealOutcome.SkippedDisposed;
  }

  const healed = await registry.reclaim(targetId, metadata);
  if (!healed) {
    return RegistryHealOutcome.NotNeeded;
  }

  if (!isStillCurrentWorker()) {
    await registry.deregister(targetId, metadata.ownerToken);
    log.warn("Target registry entry healed then rolled back; worker disposed", {
      category: TelemetryCategory.ConnectionStaleHeartbeat,
      computeTargetId: targetId,
      gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
    });
    return RegistryHealOutcome.RolledBack;
  }

  log.warn("Target registry entry was missing; healed", {
    category: TelemetryCategory.ConnectionStaleHeartbeat,
    computeTargetId: targetId,
    gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
  });
  return RegistryHealOutcome.Healed;
}

export { RegistryHealOutcome };
