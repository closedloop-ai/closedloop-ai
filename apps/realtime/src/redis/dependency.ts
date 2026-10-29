import { describeCause } from "@repo/http-service/describe-cause";
import { log } from "@repo/observability/log";
import {
  createRedisClient,
  type Redis,
  type RedisClientOptions,
} from "@repo/redis";
import { Dependency, type Readiness } from "../lifecycle/readiness";
import {
  type ConnectionCaps,
  type ConnectionCounter,
  type CounterRedis,
  createConnectionCounter,
} from "./connections";
import { connectWithIamAuth, type RedisIamAuth } from "./iam-auth";

/** The client events readiness follows; ioredis emits both. */
export type RedisEvents = {
  on(event: "ready" | "close", listener: () => void): unknown;
};

export type RedisDependencyOptions = {
  instanceId: string;
  caps: ConnectionCaps;
  readiness: Readiness;
  now?: () => number;
};

/**
 * PLN-2104 steps 7 and 8. The heartbeat is also the Redis liveness probe: a
 * stall that closes nothing still fails it within its deadline, which marks
 * Redis down; the next heartbeat that answers marks it up.
 */
export function bindRedisDependency(
  redis: CounterRedis & RedisEvents,
  options: RedisDependencyOptions
): ConnectionCounter {
  const { readiness } = options;
  const counter = createConnectionCounter({
    redis,
    instanceId: options.instanceId,
    caps: options.caps,
    now: options.now,
    onHeartbeat: (outcome) => {
      if (outcome.ok) {
        readiness.markUp(Dependency.Redis);
      } else {
        readiness.markDown(Dependency.Redis, outcome.cause);
      }
    },
  });
  redis.on("ready", () => {
    counter.heartbeat().catch(() => undefined);
  });
  redis.on("close", () =>
    readiness.markDown(Dependency.Redis, REDIS_CONNECTION_CLOSED)
  );
  return counter;
}

export type RealtimeRedisOptions = Pick<
  RedisClientOptions,
  "failWhileDisconnected"
> & {
  /** Unset connects with the URL alone, as the `default` user. */
  iamAuth?: RedisIamAuth;
};

/** Connects in the background: a Redis that is down at boot is retried, never fatal. */
export function connectRedis(
  url: string,
  options: RealtimeRedisOptions = {}
): Redis {
  const { iamAuth, ...clientOptions } = options;
  const redis = createRedisClient({
    ...clientOptions,
    url,
    onError: (error) => {
      log.warn("Realtime Redis error", {
        event: REDIS_ERROR_EVENT,
        cause: describeCause(error),
      });
    },
    logger: {
      info: (message) => log.info(message, { event: REDIS_LIFECYCLE_EVENT }),
      warn: (message) => log.warn(message, { event: REDIS_LIFECYCLE_EVENT }),
    },
  });
  if (iamAuth) {
    connectWithIamAuth(redis, iamAuth);
  } else {
    redis.connect().catch(() => undefined);
  }
  return redis;
}

const REDIS_CONNECTION_CLOSED = "connection_closed";

export const REDIS_ERROR_EVENT = "realtime.redis_error";
export const REDIS_LIFECYCLE_EVENT = "realtime.redis_lifecycle";
