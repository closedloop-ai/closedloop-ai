import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo, TargetMetadata } from "../target-registry";

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
    expect(result).toEqual(metadata);
  });

  it("returns null for an unregistered target", async () => {
    const result = await registry.lookup("nonexistent");
    expect(result).toBeNull();
  });

  it("deregisters a target when ownerToken matches", async () => {
    const metadata = makeTargetMetadata({ ownerToken: "correct-token" });
    await registry.register("target-1", metadata);

    const removed = await registry.deregister("target-1", "correct-token");
    expect(removed).toBe(true);

    const afterRemoval = await registry.lookup("target-1");
    expect(afterRemoval).toBeNull();
  });

  it("refuses to deregister when ownerToken does not match", async () => {
    const metadata = makeTargetMetadata({ ownerToken: "correct-token" });
    await registry.register("target-1", metadata);

    const removed = await registry.deregister("target-1", "wrong-token");
    expect(removed).toBe(false);

    const stillExists = await registry.lookup("target-1");
    expect(stillExists).toEqual(metadata);
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

    expect(await registry.lookup("target-a")).toBeNull();
    expect(await registry.lookup("target-b")).toBeNull();
    expect(await registry.lookup("target-c")).not.toBeNull();
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
    expect(result).toEqual(info);
  });

  it("returns null for an unregistered instance", async () => {
    const result = await registry.lookupInstance("nonexistent");
    expect(result).toBeNull();
  });

  it("removes instance info on deregisterInstance", async () => {
    const info = makeInstanceInfo();
    await registry.registerInstance("inst-1", info);
    await registry.deregisterInstance("inst-1");

    const result = await registry.lookupInstance("inst-1");
    expect(result).toBeNull();
  });

  it("refreshTtl always returns true (no-op for in-memory)", async () => {
    await registry.register("target-1", makeTargetMetadata());
    const result = await registry.refreshTtl("target-1", "owner-token-1");
    expect(result).toBe(true);
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

    it("does not throw on Redis error", async () => {
      mockRedis.set.mockRejectedValue(new Error("connection lost"));

      await expect(
        registry.register("target-1", makeTargetMetadata())
      ).resolves.toBeUndefined();
    });
  });

  describe("lookup", () => {
    it("returns parsed metadata when key exists", async () => {
      const metadata = makeTargetMetadata();
      mockRedis.get.mockResolvedValue(JSON.stringify(metadata));

      const result = await registry.lookup("target-1");
      expect(result).toEqual(metadata);
      expect(mockRedis.get).toHaveBeenCalledWith("target:target-1");
    });

    it("returns null when key does not exist", async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await registry.lookup("target-1");
      expect(result).toBeNull();
    });

    it("returns null on Redis error", async () => {
      mockRedis.get.mockRejectedValue(new Error("connection lost"));

      const result = await registry.lookup("target-1");
      expect(result).toBeNull();
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
      expect(result).toEqual(info);
      expect(mockRedis.get).toHaveBeenCalledWith("instance:inst-1");
    });

    it("returns null when key does not exist", async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await registry.lookupInstance("inst-1");
      expect(result).toBeNull();
    });

    it("returns null on Redis error", async () => {
      mockRedis.get.mockRejectedValue(new Error("connection lost"));

      const result = await registry.lookupInstance("inst-1");
      expect(result).toBeNull();
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
