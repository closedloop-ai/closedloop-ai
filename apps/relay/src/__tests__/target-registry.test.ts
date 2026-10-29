import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InstanceInfo,
  ReclaimOutcome,
  RegistryLookupOutcome,
  type TargetMetadata,
  TargetRegistryBackend,
} from "../target-registry";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis() {
  return {
    get: vi.fn<(key: string) => Promise<string | null>>(),
    set: vi.fn<(...args: unknown[]) => Promise<string>>(),
    del: vi.fn<(key: string) => Promise<number>>(),
    pexpire: vi.fn<(key: string, ms: number) => Promise<number>>(),
    eval: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    scan: vi.fn<
      (
        cursor: string,
        ...args: unknown[]
      ) => Promise<[cursor: string, keys: string[]]>
    >(),
  };
}

type MockRedis = ReturnType<typeof createMockRedis>;

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeTargetMetadata(
  overrides: Partial<TargetMetadata> = {}
): TargetMetadata {
  return {
    instanceId: "instance-1",
    socketId: "socket-1",
    ownerToken: "owner-token-1",
    organizationId: "org-1",
    userId: "user-1",
    connectedAt: Date.now(),
    ...overrides,
  };
}

function makeInstanceInfo(overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    privateIp: "10.0.0.1",
    port: 3020,
    startedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InMemoryTargetRegistry
// ---------------------------------------------------------------------------

describe("InMemoryTargetRegistry", () => {
  let registry: InstanceType<
    typeof import("../target-registry").InMemoryTargetRegistry
  >;

  beforeEach(async () => {
    const mod = await import("../target-registry");
    registry = new mod.InMemoryTargetRegistry();
  });

  it("returns metadata after registering a target", async () => {
    const metadata = makeTargetMetadata();
    await registry.register("target-1", metadata);

    const result = await registry.lookup("target-1");
    expect(result).toEqual({ outcome: RegistryLookupOutcome.Found, metadata });
  });

  it("returns missing for an unregistered target", async () => {
    const result = await registry.lookup("nonexistent");
    expect(result).toEqual({ outcome: RegistryLookupOutcome.Missing });
  });

  it("identifies the in-memory backend", () => {
    expect(registry.backend).toBe(TargetRegistryBackend.InMemory);
  });

  it("deregisters a target when ownerToken matches", async () => {
    const metadata = makeTargetMetadata({ ownerToken: "correct-token" });
    await registry.register("target-1", metadata);

    const removed = await registry.deregister("target-1", "correct-token");
    expect(removed).toBe(true);

    const afterRemoval = await registry.lookup("target-1");
    expect(afterRemoval).toEqual({ outcome: RegistryLookupOutcome.Missing });
  });

  it("refuses to deregister when ownerToken does not match", async () => {
    const metadata = makeTargetMetadata({ ownerToken: "correct-token" });
    await registry.register("target-1", metadata);

    const removed = await registry.deregister("target-1", "wrong-token");
    expect(removed).toBe(false);

    const stillExists = await registry.lookup("target-1");
    expect(stillExists).toEqual({
      outcome: RegistryLookupOutcome.Found,
      metadata,
    });
  });

  it("returns false when deregistering a nonexistent target", async () => {
    const removed = await registry.deregister("nonexistent", "any-token");
    expect(removed).toBe(false);
  });

  it("removes only entries matching the instance ID via deregisterAllByInstance", async () => {
    await registry.register(
      "target-a",
      makeTargetMetadata({ instanceId: "inst-1" })
    );
    await registry.register(
      "target-b",
      makeTargetMetadata({ instanceId: "inst-1" })
    );
    await registry.register(
      "target-c",
      makeTargetMetadata({ instanceId: "inst-2" })
    );

    const count = await registry.deregisterAllByInstance("inst-1");
    expect(count).toBe(2);

    expect(await registry.lookup("target-a")).toEqual({
      outcome: RegistryLookupOutcome.Missing,
    });
    expect(await registry.lookup("target-b")).toEqual({
      outcome: RegistryLookupOutcome.Missing,
    });
    expect(await registry.lookup("target-c")).toEqual({
      outcome: RegistryLookupOutcome.Found,
      metadata: expect.objectContaining({ instanceId: "inst-2" }),
    });
  });

  it("returns 0 when deregisterAllByInstance finds no matches", async () => {
    await registry.register(
      "target-a",
      makeTargetMetadata({ instanceId: "inst-1" })
    );

    const count = await registry.deregisterAllByInstance("inst-other");
    expect(count).toBe(0);
  });

  it("stores and retrieves instance info", async () => {
    const info = makeInstanceInfo();
    await registry.registerInstance("inst-1", info);

    const result = await registry.lookupInstance("inst-1");
    expect(result).toEqual({ outcome: RegistryLookupOutcome.Found, info });
  });

  it("returns missing for an unregistered instance", async () => {
    const result = await registry.lookupInstance("nonexistent");
    expect(result).toEqual({ outcome: RegistryLookupOutcome.Missing });
  });

  it("removes instance info on deregisterInstance", async () => {
    const info = makeInstanceInfo();
    await registry.registerInstance("inst-1", info);
    await registry.deregisterInstance("inst-1");

    const result = await registry.lookupInstance("inst-1");
    expect(result).toEqual({ outcome: RegistryLookupOutcome.Missing });
  });

  it("refreshTtl always returns true (no-op for in-memory)", async () => {
    await registry.register("target-1", makeTargetMetadata());
    const result = await registry.refreshTtl("target-1", "owner-token-1");
    expect(result).toBe(true);
  });

  it("reclaim creates a missing entry and reports it", async () => {
    const meta = makeTargetMetadata();
    expect(await registry.reclaim("target-1", meta)).toEqual({
      outcome: ReclaimOutcome.Reclaimed,
    });
    expect(await registry.lookup("target-1")).toEqual({
      outcome: RegistryLookupOutcome.Found,
      metadata: meta,
    });
  });

  it("reclaim never clobbers an existing entry", async () => {
    const original = makeTargetMetadata();
    await registry.register("target-1", original);
    const usurper = { ...makeTargetMetadata(), ownerToken: "other-owner" };
    expect(await registry.reclaim("target-1", usurper)).toEqual({
      outcome: ReclaimOutcome.Refused,
    });
    expect(await registry.lookup("target-1")).toEqual({
      outcome: RegistryLookupOutcome.Found,
      metadata: original,
    });
  });
});

// ---------------------------------------------------------------------------
// RedisTargetRegistry
// ---------------------------------------------------------------------------

describe("RedisTargetRegistry", () => {
  let registry: InstanceType<
    typeof import("../target-registry").RedisTargetRegistry
  >;
  let mockRedis: MockRedis;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    const mod = await import("../target-registry");
    registry = new mod.RedisTargetRegistry(mockRedis as never);
  });

  it("identifies the Redis backend", () => {
    expect(registry.backend).toBe(TargetRegistryBackend.Redis);
  });

  describe("register", () => {
    it("calls SET with the correct key, JSON payload, and TTL", async () => {
      const metadata = makeTargetMetadata();
      mockRedis.set.mockResolvedValue("OK");

      await registry.register("target-1", metadata);

      expect(mockRedis.set).toHaveBeenCalledWith(
        "target:target-1",
        JSON.stringify(metadata),
        "PX",
        300_000
      );
    });

    it("reports failure instead of throwing on Redis error", async () => {
      mockRedis.set.mockRejectedValue(new Error("connection lost"));

      // Resolving `false` rather than rejecting is the contract that lets the
      // caller LOG a lost registration: a rejection would never reach it,
      // because registration must not throw at a mid-handshake caller.
      await expect(
        registry.register("target-1", makeTargetMetadata())
      ).resolves.toBe(false);
    });

    it("reports success when Redis accepts the write", async () => {
      mockRedis.set.mockResolvedValue("OK");

      await expect(
        registry.register("target-1", makeTargetMetadata())
      ).resolves.toBe(true);
    });
  });

  describe("lookup", () => {
    it("returns parsed metadata when key exists", async () => {
      const metadata = makeTargetMetadata();
      mockRedis.get.mockResolvedValue(JSON.stringify(metadata));

      const result = await registry.lookup("target-1");
      expect(result).toEqual({
        outcome: RegistryLookupOutcome.Found,
        metadata,
      });
      expect(mockRedis.get).toHaveBeenCalledWith("target:target-1");
    });

    it("returns missing when key does not exist", async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await registry.lookup("target-1");
      expect(result).toEqual({ outcome: RegistryLookupOutcome.Missing });
    });

    it("returns an error outcome on Redis error", async () => {
      const error = new Error("connection lost");
      mockRedis.get.mockRejectedValue(error);

      const result = await registry.lookup("target-1");
      expect(result).toEqual({
        outcome: RegistryLookupOutcome.Error,
        error,
      });
    });

    it("returns unreadable for a value that parses but is not a target entry", async () => {
      // Valid JSON is not the same fact as a valid entry. Returning the
      // half-populated object let a caller route a dispatch at an `undefined`
      // socketId; an explicit unreadable outcome keeps it distinct from a miss.
      mockRedis.get.mockResolvedValue(
        JSON.stringify({ instanceId: "instance-1" })
      );

      const result = await registry.lookup("target-1");
      expect(result).toEqual({ outcome: RegistryLookupOutcome.Unreadable });
    });
  });

  describe("deregister", () => {
    it("calls eval with the compare-and-delete Lua script", async () => {
      mockRedis.eval.mockResolvedValue(1);

      const result = await registry.deregister("target-1", "owner-token-1");
      expect(result).toBe(true);

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("ownerToken"),
        1,
        "target:target-1",
        "owner-token-1"
      );
    });

    it("returns false when Lua script returns 0 (token mismatch)", async () => {
      mockRedis.eval.mockResolvedValue(0);

      const result = await registry.deregister("target-1", "wrong-token");
      expect(result).toBe(false);
    });

    it("returns false on Redis error", async () => {
      mockRedis.eval.mockRejectedValue(new Error("connection lost"));

      const result = await registry.deregister("target-1", "owner-token-1");
      expect(result).toBe(false);
    });
  });

  describe("refreshTtl", () => {
    it("calls eval with the compare-and-refresh Lua script", async () => {
      mockRedis.eval.mockResolvedValue(1);

      const result = await registry.refreshTtl("target-1", "owner-token-1");
      expect(result).toBe(true);

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("PEXPIRE"),
        1,
        "target:target-1",
        "owner-token-1",
        String(300_000)
      );
    });

    it("returns false when Lua script returns 0 (token mismatch or missing)", async () => {
      mockRedis.eval.mockResolvedValue(0);

      const result = await registry.refreshTtl("target-1", "wrong-token");
      expect(result).toBe(false);
    });

    it("returns false on Redis error", async () => {
      mockRedis.eval.mockRejectedValue(new Error("connection lost"));

      const result = await registry.refreshTtl("target-1", "owner-token-1");
      expect(result).toBe(false);
    });

    describe("reclaim", () => {
      // ISS-5811: SET NX so only a genuinely ABSENT key is written -- an entry
      // owned by a newer connection elsewhere must survive a stale socket's heal.
      it("re-creates via SET NX with the full metadata and TTL", async () => {
        mockRedis.set.mockResolvedValue("OK");
        const meta = makeTargetMetadata();

        const result = await registry.reclaim("target-1", meta);
        expect(result).toEqual({ outcome: ReclaimOutcome.Reclaimed });

        expect(mockRedis.set).toHaveBeenCalledWith(
          "target:target-1",
          JSON.stringify(meta),
          "PX",
          300_000,
          "NX"
        );
      });

      it("reports a refusal when the key already exists (NX refused)", async () => {
        mockRedis.set.mockResolvedValue(null);
        const result = await registry.reclaim("target-1", makeTargetMetadata());
        expect(result).toEqual({ outcome: ReclaimOutcome.Refused });
      });

      // ISS-6213: a Redis failure used to answer with the SAME value as an NX
      // refusal, so a transient registry outage was indistinguishable from
      // "somebody else legitimately owns this key" and healed nothing silently.
      it("reports a distinct error outcome carrying the cause on a Redis failure", async () => {
        const cause = new Error("connection lost");
        mockRedis.set.mockRejectedValue(cause);

        const result = await registry.reclaim("target-1", makeTargetMetadata());

        expect(result).toEqual({
          outcome: ReclaimOutcome.Error,
          error: cause,
        });
        // The discriminating half: Error must not read as the NX refusal.
        expect(result).not.toEqual({ outcome: ReclaimOutcome.Refused });
      });
    });
  });

  describe("deregisterAllByInstance", () => {
    it("scans keys and deletes entries matching the instance ID", async () => {
      const matchingMeta = makeTargetMetadata({ instanceId: "inst-1" });
      const otherMeta = makeTargetMetadata({ instanceId: "inst-2" });

      mockRedis.scan.mockResolvedValueOnce([
        "0",
        ["relay:target:t1", "relay:target:t2"],
      ]);
      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify(matchingMeta))
        .mockResolvedValueOnce(JSON.stringify(otherMeta));
      mockRedis.del.mockResolvedValue(1);

      const count = await registry.deregisterAllByInstance("inst-1");
      expect(count).toBe(1);
      expect(mockRedis.get).toHaveBeenCalledWith("target:t1");
      expect(mockRedis.get).toHaveBeenCalledWith("target:t2");
      expect(mockRedis.del).toHaveBeenCalledTimes(1);
      expect(mockRedis.del).toHaveBeenCalledWith("target:t1");
    });

    it("returns 0 on Redis error", async () => {
      mockRedis.scan.mockRejectedValue(new Error("connection lost"));

      const count = await registry.deregisterAllByInstance("inst-1");
      expect(count).toBe(0);
    });

    it("skips a corrupt value and keeps sweeping the rest (ISS-7976)", async () => {
      // One unparseable `relay:target:*` value used to abort the whole sweep
      // from inside the outer try, so every REMAINING entry of a dying
      // instance survived to TARGET_TTL_MS and peers kept routing to it.
      const matchingMeta = makeTargetMetadata({ instanceId: "inst-1" });
      mockRedis.scan.mockResolvedValueOnce([
        "0",
        ["relay:target:t1", "relay:target:t2", "relay:target:t3"],
      ]);
      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify(matchingMeta))
        .mockResolvedValueOnce("{not json at all")
        .mockResolvedValueOnce(JSON.stringify(matchingMeta));
      mockRedis.del.mockResolvedValue(1);

      const count = await registry.deregisterAllByInstance("inst-1");

      // t3 is the load-bearing one: it is AFTER the poison entry, so it only
      // gets deleted if the sweep survived t2.
      expect(mockRedis.del).toHaveBeenCalledWith("target:t3");
      expect(mockRedis.del).not.toHaveBeenCalledWith("target:t2");
      expect(count).toBe(2);
    });

    it("returns the entries actually deleted when the scan aborts mid-sweep (ISS-7976)", async () => {
      // A flat 0 here reported a false fact to the caller that logs it: one
      // deletion HAD landed before Redis went away.
      const matchingMeta = makeTargetMetadata({ instanceId: "inst-1" });
      mockRedis.scan
        .mockResolvedValueOnce(["7", ["relay:target:t1"]])
        .mockRejectedValueOnce(new Error("connection lost"));
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(matchingMeta));
      mockRedis.del.mockResolvedValue(1);

      const count = await registry.deregisterAllByInstance("inst-1");

      expect(mockRedis.del).toHaveBeenCalledWith("target:t1");
      expect(count).toBe(1);
      // Must not read as "the sweep deleted nothing" — that is the old flat 0.
      expect(count).not.toBe(0);
    });

    it("skips a valid-JSON value that is not a target entry, and does not delete it", async () => {
      // A half-written or legacy record can parse cleanly while carrying no
      // usable socketId or owner. Matching on `instanceId` alone deleted it
      // and counted it, so the shutdown log claimed a target this sweep never
      // could have been routing to.
      const matchingMeta = makeTargetMetadata({ instanceId: "inst-1" });
      mockRedis.scan.mockResolvedValueOnce([
        "0",
        ["relay:target:t1", "relay:target:t2", "relay:target:t3"],
      ]);
      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify(matchingMeta))
        // Valid JSON, matching instanceId, everything else missing.
        .mockResolvedValueOnce(JSON.stringify({ instanceId: "inst-1" }))
        .mockResolvedValueOnce(JSON.stringify(matchingMeta));
      mockRedis.del.mockResolvedValue(1);

      const count = await registry.deregisterAllByInstance("inst-1");

      expect(mockRedis.del).not.toHaveBeenCalledWith("target:t2");
      // t3 proves the malformed record was skipped, not fatal.
      expect(mockRedis.del).toHaveBeenCalledWith("target:t3");
      expect(count).toBe(2);
    });

    it("does not count a DEL that removed nothing (GET/DEL race)", async () => {
      // The key lapsed its TTL between GET and DEL, so Redis answered 0. The
      // count is the actual-deleted fact the shutdown log reports, so a
      // no-op DEL must not inflate it.
      const matchingMeta = makeTargetMetadata({ instanceId: "inst-1" });
      mockRedis.scan.mockResolvedValueOnce([
        "0",
        ["relay:target:t1", "relay:target:t2"],
      ]);
      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify(matchingMeta))
        .mockResolvedValueOnce(JSON.stringify(matchingMeta));
      mockRedis.del
        .mockResolvedValueOnce(0) // t1 vanished between GET and DEL
        .mockResolvedValueOnce(1); // t2 really was deleted

      const count = await registry.deregisterAllByInstance("inst-1");

      // Both were attempted — the discriminator is the count, not the calls.
      expect(mockRedis.del).toHaveBeenCalledWith("target:t1");
      expect(mockRedis.del).toHaveBeenCalledWith("target:t2");
      expect(count).toBe(1);
      expect(count).not.toBe(2);
    });

    it("skips a key whose GET returns null (SCAN/GET race: key expired between scan and get)", async () => {
      const matchingMeta = makeTargetMetadata({ instanceId: "inst-1" });
      // Two keys in the scan result; the first one vanishes before GET.
      mockRedis.scan.mockResolvedValueOnce([
        "0",
        ["relay:target:t1", "relay:target:t2"],
      ]);
      mockRedis.get
        .mockResolvedValueOnce(null) // t1 vanished — null data arm
        .mockResolvedValueOnce(JSON.stringify(matchingMeta)); // t2 still present
      mockRedis.del.mockResolvedValue(1);

      const count = await registry.deregisterAllByInstance("inst-1");

      // Only t2 was deleted; t1 was skipped because GET returned null.
      expect(count).toBe(1);
      expect(mockRedis.del).toHaveBeenCalledWith("target:t2");
      expect(mockRedis.del).not.toHaveBeenCalledWith("target:t1");
    });
  });

  describe("registerInstance", () => {
    it("calls SET with instance key, JSON payload, and instance TTL", async () => {
      const info = makeInstanceInfo();
      mockRedis.set.mockResolvedValue("OK");

      await registry.registerInstance("inst-1", info);

      expect(mockRedis.set).toHaveBeenCalledWith(
        "instance:inst-1",
        JSON.stringify(info),
        "PX",
        30_000
      );
    });

    it("does not throw on Redis error", async () => {
      mockRedis.set.mockRejectedValue(new Error("connection lost"));

      await expect(
        registry.registerInstance("inst-1", makeInstanceInfo())
      ).resolves.toBeUndefined();
    });
  });

  describe("lookupInstance", () => {
    it("returns parsed instance info when key exists", async () => {
      const info = makeInstanceInfo();
      mockRedis.get.mockResolvedValue(JSON.stringify(info));

      const result = await registry.lookupInstance("inst-1");
      expect(result).toEqual({ outcome: RegistryLookupOutcome.Found, info });
      expect(mockRedis.get).toHaveBeenCalledWith("instance:inst-1");
    });

    it("returns missing when key does not exist", async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await registry.lookupInstance("inst-1");
      expect(result).toEqual({ outcome: RegistryLookupOutcome.Missing });
    });

    it("returns an error outcome on Redis error", async () => {
      const error = new Error("connection lost");
      mockRedis.get.mockRejectedValue(error);

      const result = await registry.lookupInstance("inst-1");
      expect(result).toEqual({
        outcome: RegistryLookupOutcome.Error,
        error,
      });
    });

    it("returns unreadable when instance info is malformed", async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({ privateIp: "10.0.0.1" })
      );

      const result = await registry.lookupInstance("inst-1");
      expect(result).toEqual({ outcome: RegistryLookupOutcome.Unreadable });
    });
  });

  describe("deregisterInstance", () => {
    it("calls DEL with the correct instance key", async () => {
      mockRedis.del.mockResolvedValue(1);

      await registry.deregisterInstance("inst-1");

      expect(mockRedis.del).toHaveBeenCalledWith("instance:inst-1");
    });

    it("does not throw on Redis error", async () => {
      mockRedis.del.mockRejectedValue(new Error("connection lost"));

      await expect(
        registry.deregisterInstance("inst-1")
      ).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("exports TARGET_TTL_MS as 5 minutes", async () => {
    const { TARGET_TTL_MS } = await import("../target-registry");
    expect(TARGET_TTL_MS).toBe(300_000);
  });

  it("exports INSTANCE_TTL_MS as 30 seconds", async () => {
    const { INSTANCE_TTL_MS } = await import("../target-registry");
    expect(INSTANCE_TTL_MS).toBe(30_000);
  });
});
