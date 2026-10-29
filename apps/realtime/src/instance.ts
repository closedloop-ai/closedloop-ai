import { createServer, type Server as HttpServer } from "node:http";
import { createRevocations } from "@repo/realtime-contract/revocations";
import type { Redis } from "@repo/redis";
import { createRealtimeBus } from "./bus/bus";
import type { RealtimeEnv } from "./env";
import { createRealtimeRequestListener } from "./http/app";
import { createInternalOidcVerifier } from "./http/internal";
import {
  createReadiness,
  Dependency,
  type Readiness,
} from "./lifecycle/readiness";
import {
  bindRedisDependency,
  connectRedis,
  type RealtimeRedisOptions,
} from "./redis/dependency";
import { createRedisIamAuth } from "./redis/iam-auth";
import {
  composeRealtimeService,
  type RealtimeService,
  type RealtimeServiceDeps,
} from "./service";
import { startConfiguredSignalDelivery } from "./signal/delivery";

export type RealtimeInstanceDeps = Pick<
  RealtimeServiceDeps,
  "random" | "flushTelemetry" | "exit"
> & {
  /** Unique per process. */
  instanceId: string;
  /** Each Redis connection the instance opens: the shared client, the bus publisher and the bus subscriber. */
  connectRedis?: (url: string, options?: RealtimeRedisOptions) => Redis;
};

export type RealtimeInstance = RealtimeService & {
  httpServer: HttpServer;
  readiness: Readiness;
  /** Stops the connection-count heartbeat. */
  stopHeartbeat: () => void;
};

/**
 * One realtime instance as production wires it, unstarted: Redis (connection
 * counts), the bus publisher and subscriber, the LISTEN connection,
 * the Hono app for `/internal/*`, `/health` and `/ready`, and the socket
 * server. The caller listens on `httpServer`.
 */
export function createRealtimeInstance(
  env: RealtimeEnv,
  deps: RealtimeInstanceDeps
): RealtimeInstance {
  const openRedis = deps.connectRedis ?? connectRedis;
  const readiness = createReadiness([
    Dependency.Redis,
    Dependency.Bus,
    Dependency.Listener,
  ]);
  const iamAuth = env.redisIam && createRedisIamAuth(env.redisIam);
  const redis = openRedis(env.redisUrl, { iamAuth });
  const counter = bindRedisDependency(redis, {
    instanceId: deps.instanceId,
    caps: env.connectionCaps,
    readiness,
  });
  const stopHeartbeat = counter.startHeartbeat();
  const revocations = createRevocations();
  const bus = createRealtimeBus({
    publisher: openRedis(env.redisUrl, {
      iamAuth,
      failWhileDisconnected: true,
    }),
    subscriber: openRedis(env.redisUrl, { iamAuth }),
    readiness,
    revocations,
  });
  const httpServer = createServer(
    createRealtimeRequestListener({
      readiness,
      internal: {
        verifyOidc: createInternalOidcVerifier(env.internalOidc),
        bus,
      },
    })
  );
  const service = composeRealtimeService(httpServer, env, {
    random: deps.random,
    flushTelemetry: deps.flushTelemetry,
    exit: deps.exit,
    admitter: counter,
    revocations,
    startSignals: (io) =>
      startConfiguredSignalDelivery(io, readiness, env.listener),
    startBus: (io) => bus.start(io),
  });
  return { ...service, httpServer, readiness, stopHeartbeat };
}
