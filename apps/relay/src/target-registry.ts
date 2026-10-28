import { log } from "@repo/observability/log";
import { ErrorClass } from "@repo/observability/telemetry/schema";
import type { Redis } from "@repo/redis";
import { z } from "zod";

const TARGET_TTL_MS = 300_000;
const INSTANCE_TTL_MS = 30_000;
const RELAY_PREFIX_RE = /^relay:/;

const TargetRegistryBackend = {
  InMemory: "in_memory",
  Redis: "redis",
} as const;
type TargetRegistryBackend =
  (typeof TargetRegistryBackend)[keyof typeof TargetRegistryBackend];

const RegistryLookupOutcome = {
  Found: "found",
  Missing: "missing",
  Unreadable: "unreadable",
  Error: "error",
} as const;
type RegistryLookupOutcome =
  (typeof RegistryLookupOutcome)[keyof typeof RegistryLookupOutcome];

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

type TargetLookupResult =
  | { outcome: typeof RegistryLookupOutcome.Found; metadata: TargetMetadata }
  | { outcome: typeof RegistryLookupOutcome.Missing }
  | { outcome: typeof RegistryLookupOutcome.Unreadable }
  | { outcome: typeof RegistryLookupOutcome.Error; error: unknown };

type InstanceLookupResult =
  | { outcome: typeof RegistryLookupOutcome.Found; info: InstanceInfo }
  | { outcome: typeof RegistryLookupOutcome.Missing }
  | { outcome: typeof RegistryLookupOutcome.Unreadable }
  | { outcome: typeof RegistryLookupOutcome.Error; error: unknown };

type TargetRegistry = {
  readonly backend: TargetRegistryBackend;
  /**
   * Persist the registry entry for a freshly connected target.
   *
   * Resolves `false` instead of rejecting when the backing store refused the
   * write: registration is non-fatal by design (a relay that cannot reach Redis
   * still serves its local socket), but the caller must be able to SEE the loss,
   * because an unregistered target is invisible to every other relay instance
   * until the heartbeat self-heal re-creates it.
   */
  register(targetId: string, metadata: TargetMetadata): Promise<boolean>;
  lookup(targetId: string): Promise<TargetLookupResult>;
  deregister(targetId: string, ownerToken: string): Promise<boolean>;
  refreshTtl(targetId: string, ownerToken: string): Promise<boolean>;
  /**
   * Re-create a MISSING registry entry for a target this instance still holds a
   * live socket for.
   *
   * `refreshTtl` deliberately refuses to touch a key it cannot verify ownership
   * of -- but that means a lost entry (TTL lapse while heartbeats stalled, Redis
   * failover/eviction, a swallowed `register` at hello) could never come back
   * until the desktop reconnected. Until then every dispatch landing on any
   * OTHER relay instance answered `target_not_connected` instantly while the
   * desktop sat connected here (ISS-5811: the 0.4s never-started launches).
   *
   * SET NX so only a genuinely absent key is written: a live entry owned by a
   * newer connection elsewhere is never clobbered, and when two instances race
   * to heal, exactly one wins.
   *
   * Resolves a three-way {@link ReclaimResult} rather than a boolean because a
   * refusal and a store failure are opposite facts: `Refused` proves a live
   * entry exists, while `Error` proves nothing at all and leaves the target
   * undiscoverable to every other relay instance until a later heartbeat.
   */
  reclaim(targetId: string, metadata: TargetMetadata): Promise<ReclaimResult>;
  deregisterAllByInstance(instanceId: string): Promise<number>;
  registerInstance(instanceId: string, info: InstanceInfo): Promise<void>;
  lookupInstance(instanceId: string): Promise<InstanceLookupResult>;
  deregisterInstance(instanceId: string): Promise<void>;
};

class InMemoryTargetRegistry implements TargetRegistry {
  readonly backend = TargetRegistryBackend.InMemory;

  private readonly targets = new Map<string, TargetMetadata>();
  private readonly instances = new Map<string, InstanceInfo>();

  register(targetId: string, metadata: TargetMetadata): Promise<boolean> {
    this.targets.set(targetId, metadata);
    return Promise.resolve(true);
  }

  lookup(targetId: string): Promise<TargetLookupResult> {
    const metadata = this.targets.get(targetId);
    return Promise.resolve(
      metadata
        ? { outcome: RegistryLookupOutcome.Found, metadata }
        : { outcome: RegistryLookupOutcome.Missing }
    );
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

  reclaim(targetId: string, metadata: TargetMetadata): Promise<ReclaimResult> {
    if (this.targets.has(targetId)) {
      return Promise.resolve({ outcome: ReclaimOutcome.Refused });
    }
    this.targets.set(targetId, metadata);
    return Promise.resolve({ outcome: ReclaimOutcome.Reclaimed });
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

  lookupInstance(instanceId: string): Promise<InstanceLookupResult> {
    const info = this.instances.get(instanceId);
    return Promise.resolve(
      info
        ? { outcome: RegistryLookupOutcome.Found, info }
        : { outcome: RegistryLookupOutcome.Missing }
    );
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
  readonly backend = TargetRegistryBackend.Redis;

  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async register(targetId: string, metadata: TargetMetadata): Promise<boolean> {
    try {
      const result = await this.redis.set(
        `target:${targetId}`,
        JSON.stringify(metadata),
        "PX",
        TARGET_TTL_MS
      );
      return result === "OK";
    } catch {
      // Graceful degradation: never throw at a caller that is mid-handshake.
      // The `false` is what makes the loss visible instead of silent.
      return false;
    }
  }

  async lookup(targetId: string): Promise<TargetLookupResult> {
    const key = `target:${targetId}`;
    try {
      const data = await this.redis.get(key);
      if (!data) {
        return { outcome: RegistryLookupOutcome.Missing };
      }
      // Same parse boundary as the sweep, so "a stored target entry is valid"
      // has one definition in this module. An unreadable record must not come
      // back as a half-populated object: both callers route on it, and a
      // `null` here already means "not discoverable", which is the honest
      // answer for a record nothing can read.
      const metadata = parseTargetMetadata(data, key);
      return metadata
        ? { outcome: RegistryLookupOutcome.Found, metadata }
        : { outcome: RegistryLookupOutcome.Unreadable };
    } catch (error) {
      return { outcome: RegistryLookupOutcome.Error, error };
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

  async reclaim(
    targetId: string,
    metadata: TargetMetadata
  ): Promise<ReclaimResult> {
    try {
      const result = await this.redis.set(
        `target:${targetId}`,
        JSON.stringify(metadata),
        "PX",
        TARGET_TTL_MS,
        "NX"
      );
      return result === "OK"
        ? { outcome: ReclaimOutcome.Reclaimed }
        : { outcome: ReclaimOutcome.Refused };
    } catch (error) {
      // Still never throws at a mid-heartbeat caller, but the failure is now
      // its own outcome instead of borrowing the NX refusal's `false`.
      return { outcome: ReclaimOutcome.Error, error };
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

  /**
   * Delete every registry entry this instance owns. Called at SIGTERM, so its
   * failure mode is what peers see for the next {@link TARGET_TTL_MS}: an entry
   * left behind routes dispatches to a relay that is already gone, and the API
   * observes a timeout instead of an immediate `target_not_connected`.
   *
   * Two properties follow from that (ISS-7976):
   *
   * - One unreadable value must not end the sweep, so `JSON.parse` is scoped
   *   to the single entry it is parsing and the scan continues past it.
   * - The returned count is what was actually deleted, including on the
   *   store-error path: a flat `0` after N successful deletions reports a
   *   false fact to the caller that logs it. A DEL that answers 0 is not a
   *   deletion either -- the key went away between GET and DEL.
   */
  async deregisterAllByInstance(instanceId: string): Promise<number> {
    let count = 0;
    try {
      let cursor = "0";
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
          if (!data) {
            continue;
          }
          const parsed = parseTargetMetadata(data, prefixStripped);
          if (parsed?.instanceId === instanceId) {
            // DEL, not the GET above, is what proves a deletion happened. The
            // key can lapse its TTL or be swept by the entry's own reconnect
            // between the two calls, and DEL then answers 0 -- counting that
            // as a deletion reports a target this sweep did not remove.
            const deleted = await this.redis.del(prefixStripped);
            if (deleted > 0) {
              count += 1;
            }
          }
        }
      } while (cursor !== "0");
      return count;
    } catch (error) {
      log.error(
        "Target registry sweep aborted; entries left to expire on TTL",
        {
          instanceId,
          deletedBeforeAbort: count,
          errorClass: ErrorClass.Connection,
          error,
        }
      );
      return count;
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

  async lookupInstance(instanceId: string): Promise<InstanceLookupResult> {
    const key = `instance:${instanceId}`;
    try {
      const data = await this.redis.get(key);
      if (!data) {
        return { outcome: RegistryLookupOutcome.Missing };
      }
      const info = parseInstanceInfo(data, key);
      return info
        ? { outcome: RegistryLookupOutcome.Found, info }
        : { outcome: RegistryLookupOutcome.Unreadable };
    } catch (error) {
      return { outcome: RegistryLookupOutcome.Error, error };
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

/**
 * How a `reclaim` ended. Three facts, never collapsed into one: `Refused` is
 * the SET NX no-op and proves a live entry exists, while `Error` proves nothing
 * about the entry and means the target may stay undiscoverable.
 */
const ReclaimOutcome = {
  /** This call created the entry. */
  Reclaimed: "reclaimed",
  /** A live entry exists (SET NX no-op); it was deliberately left untouched. */
  Refused: "refused",
  /** The backing store failed. The entry's state is unknown. */
  Error: "error",
} as const;
type ReclaimOutcome = (typeof ReclaimOutcome)[keyof typeof ReclaimOutcome];

type ReclaimResult =
  | { outcome: typeof ReclaimOutcome.Reclaimed }
  | { outcome: typeof ReclaimOutcome.Refused }
  | { outcome: typeof ReclaimOutcome.Error; error: unknown };

/** Names the registry write a diagnostic is reporting on. */
const RegistryOperation = {
  Reclaim: "reclaim",
} as const;
type RegistryOperation =
  (typeof RegistryOperation)[keyof typeof RegistryOperation];

export type {
  InstanceInfo,
  InstanceLookupResult,
  ReclaimResult,
  TargetLookupResult,
  TargetMetadata,
  TargetRegistry,
};
export {
  INSTANCE_TTL_MS,
  InMemoryTargetRegistry,
  ReclaimOutcome,
  RedisTargetRegistry,
  RegistryLookupOutcome,
  RegistryOperation,
  TARGET_TTL_MS,
  TargetRegistryBackend,
};

/**
 * `satisfies`, never a type annotation: `z.object` strips unknown keys, so a
 * field added to {@link TargetMetadata} later would be silently dropped from
 * every read with `tsc` green. This makes the next field a compile error
 * instead. An annotation would erase the inference and leave the guard vacuous.
 *
 * Deliberately NOT `.strict()`. The entry is written by one relay instance and
 * read by another that may be a deploy behind, so an additive field from a
 * newer writer must not reject the whole record -- it is stripped, and no
 * reader here consults a field it does not know about or writes the parsed
 * object back.
 *
 * The identity fields carry `.min(1)` and `connectedAt` is a whole
 * non-negative epoch-ms because those are the values a writer can actually
 * produce: an empty `socketId` routes a dispatch at nothing, and a fractional
 * or negative timestamp is not a time this process ever recorded.
 */
const targetMetadataShape = {
  instanceId: z.string().min(1),
  socketId: z.string().min(1),
  ownerToken: z.string().min(1),
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  connectedAt: z.number().int().nonnegative(),
} satisfies Record<keyof TargetMetadata, z.ZodTypeAny>;

const targetMetadataSchema = z.object(targetMetadataShape);

const instanceInfoShape = {
  privateIp: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  startedAt: z.number().int().nonnegative(),
} satisfies Record<keyof InstanceInfo, z.ZodTypeAny>;

const instanceInfoSchema = z.object(instanceInfoShape);

/**
 * Read one stored registry value, or `null` when it cannot be read.
 *
 * A registry entry is valid-or-absent, and valid JSON is not the same fact as
 * a valid entry: a half-written or legacy value can parse cleanly and still
 * carry no usable `socketId` or owner. Both forms tell us nothing about who
 * owns the target, so both are reported and skipped rather than guessed at --
 * otherwise the sweep deletes a record it cannot read and counts it, while the
 * log calls corrupt entries absent.
 *
 * Scoped to a single entry on purpose -- inside the sweep's own try, one bad
 * value ends the whole sweep.
 */
function parseTargetMetadata(data: string, key: string): TargetMetadata | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch (error) {
    log.error("Unparseable target registry entry; skipping", {
      key,
      errorClass: ErrorClass.Protocol,
      error,
    });
    return null;
  }
  const parsed = targetMetadataSchema.safeParse(decoded);
  if (!parsed.success) {
    log.error("Malformed target registry entry; skipping", {
      key,
      issuePaths: parsed.error.issues.map((issue) => issue.path.join(".")),
      errorClass: ErrorClass.Protocol,
    });
    return null;
  }
  return parsed.data;
}

function parseInstanceInfo(data: string, key: string): InstanceInfo | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch (error) {
    log.error("Unparseable relay instance registry entry; skipping", {
      key,
      errorClass: ErrorClass.Protocol,
      error,
    });
    return null;
  }
  const parsed = instanceInfoSchema.safeParse(decoded);
  if (!parsed.success) {
    log.error("Malformed relay instance registry entry; skipping", {
      key,
      issuePaths: parsed.error.issues.map((issue) => issue.path.join(".")),
      errorClass: ErrorClass.Protocol,
    });
    return null;
  }
  return parsed.data;
}
