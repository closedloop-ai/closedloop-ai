import { TelemetryCategory } from "@repo/observability/telemetry/telemetry-category";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReclaimOutcome,
  type ReclaimResult,
  RegistryLookupOutcome,
  RegistryOperation,
  type TargetMetadata,
  type TargetRegistry,
  TargetRegistryBackend,
} from "../target-registry.js";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { log } = await import("@repo/observability/log");
const logError = vi.mocked(log.error);

const {
  healMissingRegistryEntry,
  isCurrentRegistryOwner,
  isLocalWorkerCurrentOwner,
  RegistryHealOutcome,
} = await import("../registry-ownership.js");

const RECLAIMED: ReclaimResult = { outcome: ReclaimOutcome.Reclaimed };
const REFUSED: ReclaimResult = { outcome: ReclaimOutcome.Refused };

beforeEach(() => {
  vi.clearAllMocks();
});

const BASE_METADATA: Omit<TargetMetadata, "instanceId" | "ownerToken"> = {
  socketId: "sock-1",
  organizationId: "org-1",
  userId: "user-1",
  connectedAt: 0,
};

function makeMetadata(overrides: Partial<TargetMetadata> = {}): TargetMetadata {
  return {
    ...BASE_METADATA,
    instanceId: "inst-a",
    ownerToken: "tok-1",
    ...overrides,
  };
}

function makeRegistry(overrides: Partial<TargetRegistry> = {}): TargetRegistry {
  return {
    backend: TargetRegistryBackend.Redis,
    register: vi.fn().mockResolvedValue(true),
    lookup: vi
      .fn()
      .mockResolvedValue({ outcome: RegistryLookupOutcome.Missing }),
    deregister: vi.fn().mockResolvedValue(true),
    refreshTtl: vi.fn().mockResolvedValue(true),
    reclaim: vi.fn().mockResolvedValue(RECLAIMED),
    deregisterAllByInstance: vi.fn().mockResolvedValue(0),
    registerInstance: vi.fn().mockResolvedValue(undefined),
    lookupInstance: vi
      .fn()
      .mockResolvedValue({ outcome: RegistryLookupOutcome.Missing }),
    deregisterInstance: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("isCurrentRegistryOwner (ownership source of truth)", () => {
  it("trusts the live local socket when the registry has no entry", () => {
    expect(
      isCurrentRegistryOwner(null, { ownerToken: "tok-1" }, "inst-a")
    ).toBe(true);
  });

  it("confirms ownership when instance and owner token match", () => {
    expect(
      isCurrentRegistryOwner(makeMetadata(), { ownerToken: "tok-1" }, "inst-a")
    ).toBe(true);
  });

  it("rejects a stale local socket when the target re-registered on another instance", () => {
    expect(
      isCurrentRegistryOwner(
        makeMetadata({ instanceId: "inst-b", ownerToken: "tok-2" }),
        { ownerToken: "tok-1" },
        "inst-a"
      )
    ).toBe(false);
  });

  it("rejects a stale owner token on the same instance", () => {
    expect(
      isCurrentRegistryOwner(
        makeMetadata({ ownerToken: "tok-2" }),
        { ownerToken: "tok-1" },
        "inst-a"
      )
    ).toBe(false);
  });
});

// Pins current behavior. isLocalWorkerCurrentOwner has no production caller:
// #6533 (ISS-8685) removed its only call site in index.ts and left the export.
describe("isLocalWorkerCurrentOwner", () => {
  it("rejects the local worker when the registry entry belongs to another owner", async () => {
    const registry = makeRegistry({
      lookup: vi.fn().mockResolvedValue({
        outcome: RegistryLookupOutcome.Found,
        metadata: makeMetadata({ ownerToken: "tok-2" }),
      }),
    });

    await expect(
      isLocalWorkerCurrentOwner(
        registry,
        "target-1",
        { ownerToken: "tok-1" },
        "inst-a"
      )
    ).resolves.toBe(false);
    expect(registry.lookup).toHaveBeenCalledWith("target-1");
  });

  it("confirms the local worker when the registry entry matches it", async () => {
    const registry = makeRegistry({
      lookup: vi.fn().mockResolvedValue({
        outcome: RegistryLookupOutcome.Found,
        metadata: makeMetadata(),
      }),
    });

    await expect(
      isLocalWorkerCurrentOwner(
        registry,
        "target-1",
        { ownerToken: "tok-1" },
        "inst-a"
      )
    ).resolves.toBe(true);
  });

  it("trusts the local worker when the registry lookup fails", async () => {
    const registry = makeRegistry({
      lookup: vi
        .fn()
        .mockResolvedValue({ outcome: RegistryLookupOutcome.Error }),
    });

    await expect(
      isLocalWorkerCurrentOwner(
        registry,
        "target-1",
        { ownerToken: "tok-1" },
        "inst-a"
      )
    ).resolves.toBe(true);
  });
});

describe("healMissingRegistryEntry", () => {
  it("re-creates a missing entry for a still-current worker", async () => {
    const registry = makeRegistry();
    const metadata = makeMetadata();

    const outcome = await healMissingRegistryEntry({
      registry,
      targetId: "target-1",
      metadata,
      isStillCurrentWorker: () => true,
    });

    expect(outcome).toBe(RegistryHealOutcome.Healed);
    expect(registry.reclaim).toHaveBeenCalledWith("target-1", metadata);
    expect(registry.deregister).not.toHaveBeenCalled();
  });

  it("leaves a live entry owned by a newer connection untouched", async () => {
    // reclaim is SET NX: `refused` means a key already exists.
    const registry = makeRegistry({
      reclaim: vi.fn().mockResolvedValue(REFUSED),
    });

    const outcome = await healMissingRegistryEntry({
      registry,
      targetId: "target-1",
      metadata: makeMetadata(),
      isStillCurrentWorker: () => true,
    });

    expect(outcome).toBe(RegistryHealOutcome.NotNeeded);
    expect(registry.deregister).not.toHaveBeenCalled();
    // A refusal is a DECISION, not a fault: it must not reach the alerting
    // channel that a store failure does, or the alert means nothing.
    expect(logError).not.toHaveBeenCalled();
  });

  /*
   * ISS-6213: a Redis failure and an NX refusal both answered `false`, so the
   * heal path classified an outage as "somebody else owns this key" and emitted
   * nothing. The target then stayed invisible to every other relay instance
   * until a later heartbeat happened to succeed.
   */
  it("reports a registry failure as its own outcome and alerts with target and operation context", async () => {
    const cause = new Error("connection lost");
    const registry = makeRegistry({
      reclaim: vi
        .fn()
        .mockResolvedValue({ outcome: ReclaimOutcome.Error, error: cause }),
    });

    const outcome = await healMissingRegistryEntry({
      registry,
      targetId: "target-1",
      metadata: makeMetadata(),
      gatewaySessionId: "11111111-2222-3333-4444-555555555555",
      isStillCurrentWorker: () => true,
    });

    expect(outcome).toBe(RegistryHealOutcome.Failed);
    expect(outcome).not.toBe(RegistryHealOutcome.NotNeeded);
    // Nothing was written, so nothing may be rolled back.
    expect(registry.deregister).not.toHaveBeenCalled();

    expect(logError).toHaveBeenCalledTimes(1);
    const [, meta] = logError.mock.calls[0];
    expect(meta).toMatchObject({
      // The relay-origin channel the telemetry pipeline already facets and
      // alerts on (apps/api/docs/telemetry-verification.md).
      category: TelemetryCategory.ConnectionStaleHeartbeat,
      computeTargetId: "target-1",
      registryOperation: RegistryOperation.Reclaim,
      error: cause,
    });
    // The raw gateway session id must never reach a log sink.
    expect(meta?.gatewaySessionIdHash).toEqual(expect.any(String));
    expect(meta?.gatewaySessionIdHash).not.toBe(
      "11111111-2222-3333-4444-555555555555"
    );
  });

  it("does not write at all when the worker was already disposed", async () => {
    const registry = makeRegistry();

    const outcome = await healMissingRegistryEntry({
      registry,
      targetId: "target-1",
      metadata: makeMetadata(),
      isStillCurrentWorker: () => false,
    });

    expect(outcome).toBe(RegistryHealOutcome.SkippedDisposed);
    expect(registry.reclaim).not.toHaveBeenCalled();
  });

  it("removes the entry it just created when disposal races the write", async () => {
    // The worker is current at the pre-check but disposed by the time the
    // reclaim resolves — the disconnect-mid-flight race. Without the post-write
    // re-check this publishes a DEAD target for the full 5-minute TTL, and every
    // dispatch routed to it answers target_not_connected.
    const registry = makeRegistry();
    const metadata = makeMetadata();
    const isStillCurrentWorker = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const outcome = await healMissingRegistryEntry({
      registry,
      targetId: "target-1",
      metadata,
      isStillCurrentWorker,
    });

    expect(outcome).toBe(RegistryHealOutcome.RolledBack);
    expect(registry.reclaim).toHaveBeenCalledWith("target-1", metadata);
    // Compare-and-delete on ownerToken: only ever removes OUR entry.
    expect(registry.deregister).toHaveBeenCalledWith(
      "target-1",
      metadata.ownerToken
    );
  });

  it("is idempotent across repeated heartbeats once the entry exists", async () => {
    const targets = new Map<string, TargetMetadata>();
    const registry = makeRegistry({
      reclaim: vi.fn((targetId: string, metadata: TargetMetadata) => {
        if (targets.has(targetId)) {
          return Promise.resolve(REFUSED);
        }
        targets.set(targetId, metadata);
        return Promise.resolve(RECLAIMED);
      }),
    });
    const metadata = makeMetadata();
    const call = () =>
      healMissingRegistryEntry({
        registry,
        targetId: "target-1",
        metadata,
        isStillCurrentWorker: () => true,
      });

    expect(await call()).toBe(RegistryHealOutcome.Healed);
    expect(await call()).toBe(RegistryHealOutcome.NotNeeded);
    expect(await call()).toBe(RegistryHealOutcome.NotNeeded);
    expect(targets.size).toBe(1);
  });
});
