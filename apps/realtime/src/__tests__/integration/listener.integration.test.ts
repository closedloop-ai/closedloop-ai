import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { log } from "@repo/observability/log";
import { createRevocations } from "@repo/realtime-contract/revocations";
import type { Redis } from "@repo/redis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CONNECTIONS_PER_ORG,
  DEFAULT_MAX_CONNECTIONS_PER_USER,
} from "../../env";
import { HealthPath } from "../../http/health";
import { createReadiness, Dependency } from "../../lifecycle/readiness";
import { bindRedisDependency, connectRedis } from "../../redis/dependency";
import { composeRealtimeService } from "../../service";
import { startSignalDelivery } from "../../signal/delivery";
import { ListenOnlyViolation } from "../../signal/listen-only-client";
import type { SignalListener } from "../../signal/listener";
import { listenerClientFactory } from "../../signal/pg-connection";
import {
  ALLOWED_ORIGIN,
  type EdgeHarness,
  listenEdge,
  TEST_PUBLIC_KEYS,
} from "../edge-harness";
import { realtimeHttpServer } from "../http-harness";
import { integrationListener, integrationRedisUrl } from "./integration-env";

let edge: EdgeHarness | undefined;
let listener: SignalListener | undefined;
let redis: Redis | undefined;

beforeEach(() => {
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await listener?.stop();
  await edge?.close();
  if (redis) {
    const ended = once(redis, "end");
    redis.disconnect();
    await ended;
  }
  listener = undefined;
  edge = undefined;
  redis = undefined;
  vi.restoreAllMocks();
});

describe.skipIf(!(integrationListener && integrationRedisUrl))(
  "with a real Postgres (LISTEN only) and Redis",
  () => {
    it("keeps /ready non-200 until both Redis and LISTEN are up", async () => {
      if (!(integrationListener && integrationRedisUrl)) {
        return;
      }
      const readiness = createReadiness([
        Dependency.Redis,
        Dependency.Listener,
      ]);
      const httpServer = realtimeHttpServer({ readiness });
      const { io } = composeRealtimeService(
        httpServer,
        {
          tokenPublicKeys: TEST_PUBLIC_KEYS,
          pingTimeoutMs: undefined,
          allowedOrigins: [ALLOWED_ORIGIN],
          drainWindowMs: 20_000,
        },
        {
          random: Math.random,
          flushTelemetry: async () => undefined,
          exit: vi.fn(),
          revocations: createRevocations(),
        }
      );
      edge = await listenEdge(httpServer, io);
      expect((await fetch(edge.url + HealthPath.Ready)).status).toBe(503);

      const markUp = vi.spyOn(readiness, "markUp");
      listener = startSignalDelivery(
        io,
        readiness,
        listenerClientFactory(integrationListener)
      );
      await vi.waitFor(
        () => expect(markUp).toHaveBeenCalledWith(Dependency.Listener),
        { timeout: 10_000 }
      );
      expect((await fetch(edge.url + HealthPath.Ready)).status).toBe(503);

      redis = connectRedis(integrationRedisUrl);
      bindRedisDependency(redis, {
        instanceId: randomUUID(),
        caps: {
          perUser: DEFAULT_MAX_CONNECTIONS_PER_USER,
          perOrg: DEFAULT_MAX_CONNECTIONS_PER_ORG,
        },
        readiness,
      });
      await vi.waitFor(
        async () =>
          expect((await fetch(edge?.url + HealthPath.Ready)).status).toBe(200),
        { timeout: 10_000 }
      );
    });

    it("refuses anything but LISTEN on a real connection", async () => {
      if (!integrationListener) {
        return;
      }
      const client = listenerClientFactory(integrationListener)();
      await client.connect();
      try {
        expect(() =>
          Reflect.apply(Reflect.get(client, "query"), client, ["SELECT 1"])
        ).toThrow(ListenOnlyViolation);
        await client.query("LISTEN realtime_signal");
      } finally {
        await client.end();
      }
    });
  }
);
