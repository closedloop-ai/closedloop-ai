import type { Redis } from "@repo/redis";

const TARGET_TTL_MS = 300_000;
const INSTANCE_TTL_MS = 30_000;
const RELAY_PREFIX_RE = /^relay:/;

type TargetMetadata = {
  instanceId: string;
  socketId: string;
  ownerToken: string;
  organizationId: string;
  userId: string;
  connectedAt: number;
};

type InstanceInfo = {
  privateIp: string;
  port: number;
  startedAt: number;
};

type TargetRegistry = {
  register(targetId: string, metadata: TargetMetadata): Promise<void>;
  lookup(targetId: string): Promise<TargetMetadata | null>;
  deregister(targetId: string, ownerToken: string): Promise<boolean>;
  refreshTtl(targetId: string, ownerToken: string): Promise<boolean>;
  deregisterAllByInstance(instanceId: string): Promise<number>;
  registerInstance(instanceId: string, info: InstanceInfo): Promise<void>;
  lookupInstance(instanceId: string): Promise<InstanceInfo | null>;
  deregisterInstance(instanceId: string): Promise<void>;
};

class InMemoryTargetRegistry implements TargetRegistry {
  private readonly targets = new Map<string, TargetMetadata>();
  private readonly instances = new Map<string, InstanceInfo>();

  register(targetId: string, metadata: TargetMetadata): Promise<void> {
    this.targets.set(targetId, metadata);
    return Promise.resolve();
  }

  lookup(targetId: string): Promise<TargetMetadata | null> {
    return Promise.resolve(this.targets.get(targetId) ?? null);
  }

  deregister(targetId: string, ownerToken: string): Promise<boolean> {
    const existing = this.targets.get(targetId);
    if (!existing || existing.ownerToken !== ownerToken) {
      return Promise.resolve(false);
    }
    this.targets.delete(targetId);
    return Promise.resolve(true);
  }

  refreshTtl(_targetId: string, _ownerToken: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  deregisterAllByInstance(instanceId: string): Promise<number> {
    let count = 0;
    for (const [targetId, metadata] of this.targets.entries()) {
      if (metadata.instanceId === instanceId) {
        this.targets.delete(targetId);
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  registerInstance(instanceId: string, info: InstanceInfo): Promise<void> {
    this.instances.set(instanceId, info);
    return Promise.resolve();
  }

  lookupInstance(instanceId: string): Promise<InstanceInfo | null> {
    return Promise.resolve(this.instances.get(instanceId) ?? null);
  }

  deregisterInstance(instanceId: string): Promise<void> {
    this.instances.delete(instanceId);
    return Promise.resolve();
  }
}

const COMPARE_AND_DELETE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false then return 0 end
local data = cjson.decode(current)
if data.ownerToken == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

const COMPARE_AND_REFRESH_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false then return 0 end
local data = cjson.decode(current)
if data.ownerToken == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

class RedisTargetRegistry implements TargetRegistry {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async register(targetId: string, metadata: TargetMetadata): Promise<void> {
    try {
      await this.redis.set(
        `target:${targetId}`,
        JSON.stringify(metadata),
        "PX",
        TARGET_TTL_MS
      );
    } catch {
      // graceful degradation
    }
  }

  async lookup(targetId: string): Promise<TargetMetadata | null> {
    try {
      const data = await this.redis.get(`target:${targetId}`);
      if (!data) {
        return null;
      }
      return JSON.parse(data) as TargetMetadata;
    } catch {
      return null;
    }
  }

  async deregister(targetId: string, ownerToken: string): Promise<boolean> {
    try {
      const result = (await this.redis.eval(
        COMPARE_AND_DELETE_SCRIPT,
        1,
        `target:${targetId}`,
        ownerToken
      )) as number;
      return result === 1;
    } catch {
      return false;
    }
  }

  async refreshTtl(targetId: string, ownerToken: string): Promise<boolean> {
    try {
      const result = (await this.redis.eval(
        COMPARE_AND_REFRESH_SCRIPT,
        1,
        `target:${targetId}`,
        ownerToken,
        String(TARGET_TTL_MS)
      )) as number;
      return result === 1;
    } catch {
      return false;
    }
  }

  async deregisterAllByInstance(instanceId: string): Promise<number> {
    try {
      let cursor = "0";
      let count = 0;
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          "MATCH",
          "relay:target:*",
          "COUNT",
          100
        );
        cursor = nextCursor;
        for (const rawKey of keys) {
          const prefixStripped = rawKey.replace(RELAY_PREFIX_RE, "");
          const data = await this.redis.get(prefixStripped);
          if (data) {
            const parsed = JSON.parse(data) as TargetMetadata;
            if (parsed.instanceId === instanceId) {
              await this.redis.del(prefixStripped);
              count += 1;
            }
          }
        }
      } while (cursor !== "0");
      return count;
    } catch {
      return 0;
    }
  }

  async registerInstance(
    instanceId: string,
    info: InstanceInfo
  ): Promise<void> {
    try {
      await this.redis.set(
        `instance:${instanceId}`,
        JSON.stringify(info),
        "PX",
        INSTANCE_TTL_MS
      );
    } catch {
      // graceful degradation
    }
  }

  async lookupInstance(instanceId: string): Promise<InstanceInfo | null> {
    try {
      const data = await this.redis.get(`instance:${instanceId}`);
      if (!data) {
        return null;
      }
      return JSON.parse(data) as InstanceInfo;
    } catch {
      return null;
    }
  }

  async deregisterInstance(instanceId: string): Promise<void> {
    try {
      await this.redis.del(`instance:${instanceId}`);
    } catch {
      // graceful degradation
    }
  }
}

export type { InstanceInfo, TargetMetadata, TargetRegistry };
export {
  INSTANCE_TTL_MS,
  InMemoryTargetRegistry,
  RedisTargetRegistry,
  TARGET_TTL_MS,
};
