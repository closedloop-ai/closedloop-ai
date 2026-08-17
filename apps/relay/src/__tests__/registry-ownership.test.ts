import { describe, expect, it, vi } from "vitest";
import {
  healMissingRegistryEntry,
  isCurrentRegistryOwner,
  RegistryHealOutcome,
} from "../registry-ownership.js";
import type { TargetMetadata, TargetRegistry } from "../target-registry.js";

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
    register: vi.fn().mockResolvedValue(true),
    lookup: vi.fn().mockResolvedValue(null),
    deregister: vi.fn().mockResolvedValue(true),
    refreshTtl: vi.fn().mockResolvedValue(true),
    reclaim: vi.fn().mockResolvedValue(true),
    deregisterAllByInstance: vi.fn().mockResolvedValue(0),
    registerInstance: vi.fn().mockResolvedValue(undefined),
    lookupInstance: vi.fn().mockResolvedValue(null),
    deregisterInstance: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as TargetRegistry;
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
    // reclaim is SET NX: `false` means a key already exists.
    const registry = makeRegistry({
      reclaim: vi.fn().mockResolvedValue(false),
    });

    const outcome = await healMissingRegistryEntry({
      registry,
      targetId: "target-1",
      metadata: makeMetadata(),
      isStillCurrentWorker: () => true,
    });

    expect(outcome).toBe(RegistryHealOutcome.NotNeeded);
    expect(registry.deregister).not.toHaveBeenCalled();
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
          return Promise.resolve(false);
        }
        targets.set(targetId, metadata);
        return Promise.resolve(true);
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
