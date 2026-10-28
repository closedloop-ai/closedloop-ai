import { describeCause } from "@repo/http-service/describe-cause";
import { log } from "@repo/observability/log";
import type { Admission, ConnectionAdmitter } from "../edge/admission";
import { withDeadline } from "../lifecycle/deadline";

/**
 * The ioredis commands the counter uses. Every call touches one key, so
 * nothing here raises CROSSSLOT on a cluster-mode endpoint (PLN-2105
 * decision 4 on ElastiCache Serverless).
 */
export type CounterRedis = {
  readonly status: string;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<string[]>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  del(key: string): Promise<number>;
};

export type ConnectionCaps = { perUser: number; perOrg: number };

export type HeartbeatOutcome = { ok: true } | { ok: false; cause: string };

export type ConnectionCounterOptions = {
  redis: CounterRedis;
  /** Unique per process; the field this instance writes in every count. */
  instanceId: string;
  caps: ConnectionCaps;
  onHeartbeat: (outcome: HeartbeatOutcome) => void;
  now?: () => number;
};

export type ConnectionCounter = ConnectionAdmitter & {
  /**
   * One heartbeat now, unless the client has not started connecting;
   * concurrent calls join the one in flight.
   */
  heartbeat(): Promise<void>;
  /** Beats now and every {@link HEARTBEAT_INTERVAL_MS}; returns the stop. */
  startHeartbeat(): () => void;
};

/**
 * PLN-2104 step 7. `rt:conn:user:{sub}` and `rt:conn:org:{org}` are hashes
 * with one field per instance, holding that instance's live connections. A
 * total counts only the fields of instances whose heartbeat in
 * `rt:conn:instances` is current, so a crashed instance's connections stop
 * counting within {@link INSTANCE_TTL_MS}; the next heartbeat of an instance
 * that has reached Redis for a full TTL then deletes its fields through the
 * per-instance key set, which drops a key once this instance holds nothing
 * under it.
 *
 * Admission increments first and checks the total after, so two concurrent
 * handshakes at the cap can both be refused but never both admitted.
 *
 * While Redis is unreachable a connection is admitted uncounted: losing
 * Redis degrades the instance (PLN-2104 step 8), it does not refuse clients.
 */
export function createConnectionCounter(
  options: ConnectionCounterOptions
): ConnectionCounter {
  const { redis, instanceId, caps } = options;
  const now = options.now ?? Date.now;
  const ownKeysKey = instanceKeysKey(instanceId);
  let liveInstances: ReadonlySet<string> = new Set([instanceId]);
  let heartbeatInFlight: Promise<void> | undefined;
  let sweeping = false;
  let uncountedSinceHeartbeat = false;
  let reachableSince: number | undefined;
  const unreleased = new Map<string, number>();
  // Increments this instance has issued per key and not yet released. Only
  // this instance writes its own field and key set, and every command on one
  // key goes out in the order issued, so the SREM at zero is issued before any
  // later admission's SADD and after any earlier one's.
  const held = new Map<string, number>();
  const claimedUnswept = new Set<string>();

  const hold = (key: string): void => {
    held.set(key, (held.get(key) ?? 0) + 1);
  };

  const drop = (key: string): void => {
    const count = (held.get(key) ?? 0) - 1;
    if (count > 0) {
      held.set(key, count);
      return;
    }
    held.delete(key);
    redis.srem(ownKeysKey, key).catch(() => undefined);
  };

  const give = (key: string): void => {
    redis.eval(RELEASE_SCRIPT, 1, key, instanceId).then(
      () => drop(key),
      (error: unknown) => {
        unreleased.set(key, (unreleased.get(key) ?? 0) + 1);
        log.warn("Realtime connection release deferred", {
          event: CONNECTION_RELEASE_DEFERRED_EVENT,
          cause: describeCause(error),
        });
      }
    );
  };

  const retryUnreleased = (): void => {
    const pending = [...unreleased];
    unreleased.clear();
    for (const [key, count] of pending) {
      for (let index = 0; index < count; index += 1) {
        give(key);
      }
    }
  };

  const take = async (key: string, cap: number): Promise<boolean> => {
    // Recorded before the increment, so a crash between the two leaves no
    // field the sweep cannot find. A failed write keeps its hold: the
    // increment may have landed, so the key stays where the sweep finds it.
    hold(key);
    await redis.sadd(ownKeysKey, key);
    await redis.hincrby(key, instanceId, 1);
    let total: number;
    try {
      total = liveTotal(await redis.hgetall(key), liveInstances, instanceId);
    } catch (error) {
      give(key);
      throw error;
    }
    if (total <= cap) {
      return true;
    }
    give(key);
    return false;
  };

  const takeBoth = async (sub: string, org: string): Promise<Admission> => {
    const userKey = userConnectionsKey(sub);
    const orgKey = orgConnectionsKey(org);
    if (!(await take(userKey, caps.perUser))) {
      return REFUSED;
    }
    let orgTaken: boolean;
    try {
      orgTaken = await take(orgKey, caps.perOrg);
    } catch (error) {
      give(userKey);
      throw error;
    }
    if (!orgTaken) {
      give(userKey);
      return REFUSED;
    }
    return {
      admitted: true,
      release: () => {
        give(userKey);
        give(orgKey);
      },
    };
  };

  const admitUncounted = (cause: string): Admission => {
    if (!uncountedSinceHeartbeat) {
      uncountedSinceHeartbeat = true;
      log.warn("Realtime connections admitted uncounted", {
        event: CONNECTION_UNCOUNTED_EVENT,
        cause,
      });
    }
    return { admitted: true, release: () => undefined };
  };

  const sweep = async (deadInstanceId: string): Promise<void> => {
    // The lapse is rechecked and the lease removed in one step, so a peer
    // that beat after the snapshot keeps its lease and its fields, and only
    // one instance sweeps each lapse. A claimed sweep that fails is retried
    // by this instance.
    // lc-debt: a sweeper that exits between the claim and the deletes leaves
    // that instance's fields in place, uncounted; a claim lease that expires
    // would let a peer finish it.
    if (!claimedUnswept.has(deadInstanceId)) {
      const claimed = await redis.eval(
        CLAIM_LAPSED_SCRIPT,
        1,
        INSTANCES_KEY,
        deadInstanceId,
        String(now())
      );
      if (claimed !== 1) {
        return;
      }
      claimedUnswept.add(deadInstanceId);
    }
    const keysKey = instanceKeysKey(deadInstanceId);
    const keys = await redis.smembers(keysKey);
    for (let start = 0; start < keys.length; start += SWEEP_BATCH_SIZE) {
      const batch = keys.slice(start, start + SWEEP_BATCH_SIZE);
      await Promise.all(batch.map((key) => redis.hdel(key, deadInstanceId)));
    }
    await redis.del(keysKey);
    claimedUnswept.delete(deadInstanceId);
    log.info("Realtime swept a stopped instance's connection counts", {
      event: INSTANCE_SWEPT_EVENT,
      instanceId: deadInstanceId,
      keys: keys.length,
    });
  };

  const sweepDead = async (deadInstanceIds: readonly string[]) => {
    if (sweeping) {
      return;
    }
    sweeping = true;
    try {
      for (const deadInstanceId of new Set([
        ...claimedUnswept,
        ...deadInstanceIds,
      ])) {
        if (deadInstanceId !== instanceId) {
          await sweep(deadInstanceId);
        }
      }
    } catch (error) {
      log.warn("Realtime instance sweep failed", {
        event: INSTANCE_SWEEP_FAILED_EVENT,
        cause: describeCause(error),
      });
    } finally {
      sweeping = false;
    }
  };

  const beat = async (): Promise<{ at: number; dead: string[] }> => {
    const at = now();
    await redis.zadd(INSTANCES_KEY, at + INSTANCE_TTL_MS, instanceId);
    const live = await redis.zrangebyscore(INSTANCES_KEY, at, "+inf");
    liveInstances = new Set([...live, instanceId]);
    const dead = await redis.zrangebyscore(INSTANCES_KEY, "-inf", `(${at}`);
    return { at, dead };
  };

  const heartbeat = (): Promise<void> => {
    // A client that has not started connecting, as an IAM connection waits
    // for its first token, would queue each beat until it does.
    if (redis.status === REDIS_WAIT_STATUS) {
      return Promise.resolve();
    }
    heartbeatInFlight ??= withDeadline(beat(), HEARTBEAT_TIMEOUT_MS)
      .then(
        ({ at, dead }) => {
          reachableSince ??= at;
          uncountedSinceHeartbeat = false;
          retryUnreleased();
          options.onHeartbeat({ ok: true });
          // A Redis outage stops every peer's heartbeat too, so a lapse is
          // proof of a crash only once this instance has reached Redis for a
          // full TTL, long enough for a live peer to have beaten again.
          if (at - reachableSince >= INSTANCE_TTL_MS) {
            // Outside the deadline: a large sweep is slow, not a sign Redis is lost.
            sweepDead(dead).catch(() => undefined);
          }
        },
        (error: unknown) => {
          reachableSince = undefined;
          options.onHeartbeat({ ok: false, cause: describeCause(error) });
        }
      )
      .finally(() => {
        heartbeatInFlight = undefined;
      });
    return heartbeatInFlight;
  };

  return {
    async admit({ sub, org }) {
      if (redis.status !== REDIS_READY_STATUS) {
        return admitUncounted(UNCOUNTED_NOT_CONNECTED);
      }
      const pending = takeBoth(sub, org);
      try {
        return await withDeadline(pending, ADMISSION_TIMEOUT_MS);
      } catch (error) {
        // A take that lands after the deadline is given back when it does.
        pending.then(
          (admission) => {
            if (admission.admitted) {
              admission.release();
            }
          },
          () => undefined
        );
        return admitUncounted(describeCause(error));
      }
    },
    heartbeat,
    startHeartbeat() {
      heartbeat().catch(() => undefined);
      const timer = setInterval(() => {
        heartbeat().catch(() => undefined);
      }, HEARTBEAT_INTERVAL_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

/**
 * Counts the fields of live instances. A field that is not a nonnegative
 * integer is corrupt: it is logged and not counted, never read as a number.
 */
function liveTotal(
  fields: Record<string, string>,
  liveInstances: ReadonlySet<string>,
  instanceId: string
): number {
  let total = 0;
  for (const [field, raw] of Object.entries(fields)) {
    if (field !== instanceId && !liveInstances.has(field)) {
      continue;
    }
    const count = Number(raw);
    if (raw.trim() === "" || !Number.isSafeInteger(count) || count < 0) {
      log.warn("Realtime connection count field is corrupt", {
        event: CONNECTION_COUNT_CORRUPT_EVENT,
        instanceId: field,
      });
      continue;
    }
    total += count;
  }
  return total;
}

export function userConnectionsKey(sub: string): string {
  return `rt:conn:user:${sub}`;
}

export function orgConnectionsKey(org: string): string {
  return `rt:conn:org:${org}`;
}

/** Every count key an instance holds a field in, for its sweep. */
export function instanceKeysKey(instanceId: string): string {
  return `rt:conn:keys:${instanceId}`;
}

/** Scored by the time each instance's heartbeat lapses. */
export const INSTANCES_KEY = "rt:conn:instances";

/**
 * Decrements one instance's field and deletes it at zero, atomically, so a
 * concurrent increment is never deleted with it. Never goes below zero: a
 * field the sweep already removed stays removed.
 */
export const RELEASE_SCRIPT = `local count = tonumber(redis.call("HGET", KEYS[1], ARGV[1]) or "0")
if count <= 1 then
  redis.call("HDEL", KEYS[1], ARGV[1])
  return 0
end
return redis.call("HINCRBY", KEYS[1], ARGV[1], -1)`;

/**
 * Removes an instance's lease only if it has lapsed by `ARGV[2]`, returning 1
 * when it did. One key, so it runs on a cluster-mode endpoint.
 */
export const CLAIM_LAPSED_SCRIPT = `local lease = redis.call("ZSCORE", KEYS[1], ARGV[1])
if lease and tonumber(lease) < tonumber(ARGV[2]) then
  redis.call("ZREM", KEYS[1], ARGV[1])
  return 1
end
return 0`;

const REFUSED: Admission = { admitted: false };
const REDIS_READY_STATUS = "ready";
const REDIS_WAIT_STATUS = "wait";
const UNCOUNTED_NOT_CONNECTED = "not_connected";

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const INSTANCE_TTL_MS = 3 * HEARTBEAT_INTERVAL_MS;
export const HEARTBEAT_TIMEOUT_MS = 2000;
export const ADMISSION_TIMEOUT_MS = 1000;
const SWEEP_BATCH_SIZE = 500;

export const CONNECTION_UNCOUNTED_EVENT = "realtime.connection_uncounted";
export const CONNECTION_RELEASE_DEFERRED_EVENT =
  "realtime.connection_release_deferred";
export const CONNECTION_COUNT_CORRUPT_EVENT =
  "realtime.connection_count_corrupt";
export const INSTANCE_SWEPT_EVENT = "realtime.instance_swept";
export const INSTANCE_SWEEP_FAILED_EVENT = "realtime.instance_sweep_failed";
