import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { log } from "@repo/observability/log";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { RealtimeEvent } from "@repo/realtime-contract/protocol";
import { createRevocations } from "@repo/realtime-contract/revocations";
import { createRedisClient, type Redis } from "@repo/redis";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CONNECTIONS_PER_ORG,
  DEFAULT_MAX_CONNECTIONS_PER_USER,
} from "../../env";
import { HealthPath } from "../../http/health";
import {
  createReadiness,
  Dependency,
  type Readiness,
} from "../../lifecycle/readiness";
import {
  CLAIM_LAPSED_SCRIPT,
  type ConnectionCaps,
  type ConnectionCounter,
  createConnectionCounter,
  INSTANCE_TTL_MS,
  INSTANCES_KEY,
  instanceKeysKey,
  orgConnectionsKey,
  RELEASE_SCRIPT,
  userConnectionsKey,
} from "../../redis/connections";
import { bindRedisDependency, connectRedis } from "../../redis/dependency";
import { composeRealtimeService } from "../../service";
import {
  ALLOWED_ORIGIN,
  connectError,
  type EdgeHarness,
  listenEdge,
  nextEvent,
  ORG_A,
  openClient,
  TEST_PUBLIC_KEYS,
  tokenFor,
  validAuth,
} from "../edge-harness";
import { FakeRedisStore } from "../fake-redis";
import { realtimeHttpServer } from "../http-harness";
import { integrationRedisUrl } from "./integration-env";

const DEFAULT_CAPS: ConnectionCaps = {
  perUser: DEFAULT_MAX_CONNECTIONS_PER_USER,
  perOrg: DEFAULT_MAX_CONNECTIONS_PER_ORG,
};

type Instance = EdgeHarness & {
  readiness: Readiness;
  counter: ConnectionCounter;
  redis: Redis;
};

const instances: Instance[] = [];
const clients: ClientSocket[] = [];
const admins: Redis[] = [];

async function startInstance(
  redisUrl: string,
  caps: ConnectionCaps
): Promise<Instance> {
  const readiness = createReadiness([Dependency.Redis]);
  const redis = connectRedis(redisUrl);
  const counter = bindRedisDependency(redis, {
    instanceId: randomUUID(),
    caps,
    readiness,
  });
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
      admitter: counter,
      revocations: createRevocations(),
    }
  );
  const edge = await listenEdge(httpServer, io);
  const instance = { ...edge, readiness, counter, redis };
  instances.push(instance);
  return instance;
}

async function welcomed(url: string, token: string): Promise<ClientSocket> {
  const client = openClient(url, validAuth(token));
  clients.push(client);
  await nextEvent(client, RealtimeEvent.Welcome);
  return client;
}

function adminClient(redisUrl: string): Redis {
  const admin = createRedisClient({ url: redisUrl });
  admins.push(admin);
  return admin;
}

beforeEach(() => {
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
  for (const instance of instances.splice(0)) {
    await instance.close();
    await closeRedis(instance.redis);
  }
  for (const admin of admins.splice(0)) {
    await closeRedis(admin);
  }
  vi.restoreAllMocks();
});

/** Resolves once the client has emitted `end`, so no lifecycle log outlives the file. */
async function closeRedis(redis: Redis): Promise<void> {
  const ended = once(redis, "end");
  redis.disconnect();
  await ended;
}

describe.skipIf(!integrationRedisUrl)("with a real Redis", () => {
  const redisUrl = integrationRedisUrl ?? "";

  it.each([
    ["decrements a count above one", 3, "2"],
    ["deletes the field at one", 1, undefined],
    ["leaves a field the sweep removed removed", 0, undefined],
  ] as const)(
    "runs the release script, and the unit suite's fake agrees: %s",
    async (_case, before, after) => {
      const key = `rt:conn:test:${randomUUID()}`;
      const admin = adminClient(redisUrl);
      await admin.connect();
      const fake = new FakeRedisStore().client();
      if (before > 0) {
        await admin.hincrby(key, "i-1", before);
        await fake.hincrby(key, "i-1", before);
      }

      await admin.eval(RELEASE_SCRIPT, 1, key, "i-1");
      await fake.eval(RELEASE_SCRIPT, 1, key, "i-1");

      expect((await admin.hget(key, "i-1")) ?? undefined).toBe(after);
      expect((await fake.hgetall(key))["i-1"]).toBe(after);
      await admin.del(key);
    }
  );

  it.each([
    ["removes a lapsed lease", 999, 1, false],
    ["keeps a lease renewed past the claim", 1001, 0, true],
    ["claims nothing for an absent lease", undefined, 0, false],
  ] as const)(
    "runs the claim script, and the unit suite's fake agrees: %s",
    async (_case, lease, claimed, kept) => {
      const key = `rt:conn:test:${randomUUID()}`;
      const admin = adminClient(redisUrl);
      await admin.connect();
      const fake = new FakeRedisStore().client();
      if (lease !== undefined) {
        await admin.zadd(key, lease, "i-1");
        await fake.zadd(key, lease, "i-1");
      }

      expect(await admin.eval(CLAIM_LAPSED_SCRIPT, 1, key, "i-1", "1000")).toBe(
        claimed
      );
      expect(await fake.eval(CLAIM_LAPSED_SCRIPT, 1, key, "i-1", "1000")).toBe(
        claimed
      );
      expect((await admin.zscore(key, "i-1")) !== null).toBe(kept);
      expect((await fake.zrangebyscore(key, "-inf", "+inf")).length > 0).toBe(
        kept
      );
      await admin.del(key);
    }
  );

  describe("a counter on a real Redis", () => {
    let clock: number;
    const instanceIds: string[] = [];

    beforeEach(() => {
      clock = 1_000_000;
    });

    afterEach(async () => {
      const admin = adminClient(redisUrl);
      await admin.connect();
      for (const instanceId of instanceIds.splice(0)) {
        await admin.zrem(INSTANCES_KEY, instanceId);
        await admin.del(instanceKeysKey(instanceId));
      }
    });

    async function counterOn(
      caps: ConnectionCaps = DEFAULT_CAPS
    ): Promise<{ counter: ConnectionCounter; redis: Redis; id: string }> {
      const redis = adminClient(redisUrl);
      await redis.connect();
      const id = randomUUID();
      instanceIds.push(id);
      const counter = createConnectionCounter({
        redis,
        instanceId: id,
        caps,
        onHeartbeat: () => undefined,
        now: () => clock,
      });
      return { counter, redis, id };
    }

    it("leaves a peer that beats after the lapse snapshot its lease and its fields", async () => {
      const survivor = await counterOn();
      const peer = await counterOn();
      const sub = `user_${randomUUID()}`;
      const userKey = userConnectionsKey(sub);
      const orgKey = orgConnectionsKey(ORG_A);
      await survivor.counter.heartbeat();
      await peer.counter.heartbeat();
      await peer.counter.admit({ sub, org: ORG_A });
      clock += INSTANCE_TTL_MS + 1;
      const snapshot = survivor.redis.zrangebyscore.bind(survivor.redis);
      vi.spyOn(survivor.redis, "zrangebyscore").mockImplementation(
        async (key, min, max) => {
          const members = await snapshot(key, min, max);
          if (min === "-inf") {
            await peer.counter.heartbeat();
          }
          return members;
        }
      );
      const evals = vi.spyOn(survivor.redis, "eval");

      await survivor.counter.heartbeat();
      await vi.waitFor(() =>
        expect(evals).toHaveBeenCalledWith(
          CLAIM_LAPSED_SCRIPT,
          1,
          INSTANCES_KEY,
          peer.id,
          String(clock)
        )
      );
      const claims = evals.mock.calls.flatMap((call, index) =>
        call[3] === peer.id ? [evals.mock.results[index]?.value] : []
      );
      expect(await Promise.all(claims)).toEqual([0]);

      const admin = adminClient(redisUrl);
      await admin.connect();
      expect(await admin.hget(userKey, peer.id)).toBe("1");
      expect(await admin.hget(orgKey, peer.id)).toBe("1");
      expect(await admin.zscore(INSTANCES_KEY, peer.id)).not.toBeNull();
      expect(new Set(await admin.smembers(instanceKeysKey(peer.id)))).toEqual(
        new Set([orgKey, userKey])
      );
      await admin.hdel(userKey, peer.id);
      await admin.hdel(orgKey, peer.id);
    });

    it("drops each key from the instance's key set once it holds nothing under it", async () => {
      const { counter, id } = await counterOn({ perUser: 20, perOrg: 1 });
      const org = randomUUID();
      const admitted = await counter.admit({
        sub: `user_${randomUUID()}`,
        org,
      });
      const refused = await counter.admit({ sub: `user_${randomUUID()}`, org });
      expect(refused.admitted).toBe(false);
      if (!admitted.admitted) {
        throw new Error("expected admitted");
      }

      admitted.release();

      const admin = adminClient(redisUrl);
      await admin.connect();
      await vi.waitFor(async () =>
        expect(await admin.exists(instanceKeysKey(id))).toBe(0)
      );
      expect(await admin.exists(orgConnectionsKey(org))).toBe(0);
    });
  });

  it("keeps /ready non-200 until Redis is connected", async () => {
    const instance = await startInstance(redisUrl, DEFAULT_CAPS);
    // connectRedis connects in the background; nothing has answered yet.
    expect((await fetch(instance.url + HealthPath.Ready)).status).toBe(503);
    expect((await fetch(instance.url + HealthPath.Health)).status).toBe(200);

    await vi.waitFor(
      async () =>
        expect((await fetch(instance.url + HealthPath.Ready)).status).toBe(200),
      { timeout: 5000 }
    );
  });

  it("enforces the per-user cap across two instances sharing Redis", async () => {
    const caps = { perUser: 2, perOrg: 2000 };
    const first = await startInstance(redisUrl, caps);
    const second = await startInstance(redisUrl, caps);
    await vi.waitFor(() => {
      expect(first.readiness.isReady()).toBe(true);
      expect(second.readiness.isReady()).toBe(true);
    });
    // Each has seen the other's heartbeat.
    await first.counter.heartbeat();
    await second.counter.heartbeat();
    const sub = `user_${randomUUID()}`;
    const token = await tokenFor(ORG_A, sub);

    await welcomed(first.url, token);
    const onSecond = await welcomed(second.url, token);
    const refused = openClient(second.url, validAuth(token));
    clients.push(refused);
    expect(await connectError(refused)).toEqual({
      code: RealtimeErrorCode.RateLimited,
    });

    // A disconnect on one instance frees a slot for the other.
    onSecond.disconnect();
    await vi.waitFor(async () => {
      const retry = openClient(first.url, validAuth(token));
      clients.push(retry);
      await nextEvent(retry, RealtimeEvent.Welcome);
    });
  });

  it("stays healthy and keeps its sockets when Redis stalls after readiness, and reports degraded", async () => {
    const instance = await startInstance(redisUrl, DEFAULT_CAPS);
    await vi.waitFor(() => expect(instance.readiness.isReady()).toBe(true));
    const client = await welcomed(
      instance.url,
      await tokenFor(ORG_A, `user_${randomUUID()}`)
    );
    const admin = adminClient(redisUrl);
    await admin.connect();

    await admin.call("CLIENT", "PAUSE", "4000", "ALL");
    await instance.counter.heartbeat();

    expect(instance.readiness.isDegraded()).toBe(true);
    const health = await fetch(instance.url + HealthPath.Health);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ degraded: true });
    expect((await fetch(instance.url + HealthPath.Ready)).status).toBe(200);
    expect(client.connected).toBe(true);

    await vi.waitFor(
      async () => {
        await instance.counter.heartbeat();
        expect(instance.readiness.isDegraded()).toBe(false);
      },
      { timeout: 10_000, interval: 500 }
    );
    expect(client.connected).toBe(true);
  });
});
