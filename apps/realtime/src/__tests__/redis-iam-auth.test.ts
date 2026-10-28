import { EventEmitter } from "node:events";
import { OIDC_CONFIG } from "@repo/http-service/test-support/oidc-fixture";
import { log } from "@repo/observability/log";
import type { Redis } from "@repo/redis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRealtimeEnv } from "../env";
import { createRealtimeInstance } from "../instance";
import { connectRedis, type RealtimeRedisOptions } from "../redis/dependency";
import {
  CREDENTIALS_EXPIRING_CODE,
  CREDENTIALS_FLOOR_MS,
  connectWithIamAuth,
  createRedisIamAuth,
  REDIS_IAM_REAUTH_FAILED_EVENT,
  REDIS_IAM_TOKEN_FAILED_EVENT,
  type RedisIamAuth,
  TOKEN_REFRESH_MS,
} from "../redis/iam-auth";
import { TEST_PUBLIC_KEYS_JSON } from "./edge-harness";
import { FakeBusHub } from "./fake-bus";
import { FakeRedisStore } from "./fake-redis";

const USER_ID = "example-stage-realtime";

const MINTED_TOKEN = /^token-\d+$/;

/** AWS's limits on an IAM connection (AmazonElastiCache/latest/dg/auth-iam.html). */
const TOKEN_VALIDITY_MS = 15 * 60 * 1000;
const IAM_CONNECTION_LIMIT_MS = 12 * 60 * 60 * 1000;
const STAGE_CACHE = {
  cacheName: "example-stage-realtime-cache",
  userId: USER_ID,
  region: "us-east-1",
};

class FakeIamClient extends EventEmitter {
  readonly options: { username?: string; password?: string } = {};
  condition: { select: number; subscriber: unknown } | null = null;
  mode = "normal";
  readonly auth = vi.fn<
    (username: string, password: string) => Promise<unknown>
  >(() => Promise.resolve("OK"));
  /** Called with the password each real connect would AUTH with. */
  readonly connected = vi.fn<(password: string | undefined) => void>();
  readonly disconnect = vi.fn();

  connect(): Promise<void> {
    this.connected(this.options.password);
    return Promise.resolve();
  }
}

function sequentialTokens(): RedisIamAuth & {
  mintToken: ReturnType<typeof vi.fn>;
} {
  let minted = 0;
  return {
    userId: USER_ID,
    mintToken: vi.fn(() => {
      minted += 1;
      return Promise.resolve(`token-${minted}`);
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createRedisIamAuth", () => {
  it("mints the token AWS's IAMAuthTokenRequest builds for a serverless cache", async () => {
    const auth = createRedisIamAuth(STAGE_CACHE, {
      credentials: () =>
        Promise.resolve({
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
          sessionToken: "FwoGZXIvYXdzEXAMPLE+token/=",
        }),
      now: () => new Date("2026-10-05T12:00:00Z"),
    });

    // The signature is botocore's SigV4QueryAuth over the same request, credentials and clock.
    expect(await auth.mintToken()).toBe(
      "example-stage-realtime-cache/?Action=connect&ResourceType=ServerlessCache&User=example-stage-realtime&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261005%2Fus-east-1%2Felasticache%2Faws4_request&X-Amz-Date=20261005T120000Z&X-Amz-Expires=900&X-Amz-Security-Token=FwoGZXIvYXdzEXAMPLE%2Btoken%2F%3D&X-Amz-Signature=b3cf7d776a0342817cd91db073ba66a7d3116beb757592d562e30c59c0eb451f&X-Amz-SignedHeaders=host"
    );
    expect(auth.userId).toBe(USER_ID);
  });

  it("mints nothing when even refreshed credentials expire inside the floor", async () => {
    const expiring = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      expiration: new Date(Date.now() + CREDENTIALS_FLOOR_MS - 1),
    };
    const auth = createRedisIamAuth(STAGE_CACHE, {
      credentials: () => Promise.resolve(expiring),
    });

    await expect(auth.mintToken()).rejects.toMatchObject({
      code: CREDENTIALS_EXPIRING_CODE,
    });
  });
});

describe("connectWithIamAuth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("connects as the IAM user only once the first token is minted, even when a command asks first", async () => {
    let release: (token: string) => void = () => undefined;
    const client = new FakeIamClient();
    connectWithIamAuth(client, {
      userId: USER_ID,
      mintToken: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    // What ioredis does for a command sent while it waits.
    client.connect().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.connected).not.toHaveBeenCalled();

    release("token-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(client.options).toEqual({ username: USER_ID, password: "token-1" });
    expect(client.connected).toHaveBeenCalled();
    expect(client.connected).not.toHaveBeenCalledWith(undefined);
  });

  it("joins every connect to one held connect until the first token, then lets ioredis reconnect", async () => {
    let release: (token: string) => void = () => undefined;
    const client = new FakeIamClient();
    connectWithIamAuth(client, {
      userId: USER_ID,
      mintToken: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    const held = client.connect();
    expect(client.connect()).toBe(held);
    release("token-1");
    await held;
    expect(client.connected).toHaveBeenCalledTimes(1);

    // ioredis's own reconnect after a close.
    await client.connect();
    expect(client.connected).toHaveBeenCalledTimes(2);
  });

  it("signs a token with fresh credentials when the SDK's cached ones lapse before the next refresh", async () => {
    const expiring = {
      accessKeyId: "AKIDEXPIRING",
      secretAccessKey: "secret",
      expiration: new Date(
        Date.now() + CREDENTIALS_FLOOR_MS + TOKEN_REFRESH_MS / 2
      ),
    };
    const fresh = {
      accessKeyId: "AKIDFRESH",
      secretAccessKey: "secret",
      expiration: new Date(Date.now() + 60 * 60 * 1000),
    };
    // As the SDK's memoizeChain: the cached credentials until they expire.
    const credentials = (options?: { forceRefresh?: boolean }) =>
      Promise.resolve(
        options?.forceRefresh || expiring.expiration.getTime() <= Date.now()
          ? fresh
          : expiring
      );
    const client = new FakeIamClient();
    connectWithIamAuth(
      client,
      createRedisIamAuth(STAGE_CACHE, { credentials })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(client.options.password).toContain(
      "X-Amz-Credential=AKIDEXPIRING%2F"
    );

    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MS);

    expect(client.options.password).toContain("X-Amz-Credential=AKIDFRESH%2F");
  });

  it("keeps re-minting, so no token outlives its 15 minutes or the credentials that signed it", async () => {
    const client = new FakeIamClient();
    const mintedAt: number[] = [];
    connectWithIamAuth(client, {
      userId: USER_ID,
      mintToken: () => {
        mintedAt.push(Date.now());
        return Promise.resolve(`token-${mintedAt.length}`);
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(IAM_CONNECTION_LIMIT_MS);

    const ages = [...mintedAt.slice(1), Date.now()].map(
      (at, index) => at - (mintedAt[index] ?? 0)
    );
    expect(ages.length).toBeGreaterThan(
      IAM_CONNECTION_LIMIT_MS / TOKEN_VALIDITY_MS
    );
    expect(Math.max(...ages)).toBeLessThan(CREDENTIALS_FLOOR_MS);
    expect(client.options.password).toBe(`token-${mintedAt.length}`);
    expect(client.connected).toHaveBeenCalledTimes(1);
  });

  it("keeps the last token when a mint fails, and retries inside its validity", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const client = new FakeIamClient();
    const auth = sequentialTokens();
    auth.mintToken
      .mockResolvedValueOnce("token-1")
      .mockRejectedValueOnce(new Error("credentials unavailable"))
      .mockResolvedValue("token-3");
    connectWithIamAuth(client, auth);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MS);
    expect(auth.mintToken).toHaveBeenCalledTimes(2);
    expect(client.options.password).toBe("token-1");
    expect(warn).toHaveBeenCalledWith(
      "Realtime Redis IAM token mint failed",
      expect.objectContaining({ event: REDIS_IAM_TOKEN_FAILED_EVENT })
    );

    await vi.advanceTimersByTimeAsync(TOKEN_VALIDITY_MS - TOKEN_REFRESH_MS - 1);
    expect(client.options.password).toBe("token-3");
  });

  it("re-AUTHs a command connection in place before each of ElastiCache's 12-hour limits", async () => {
    const client = new FakeIamClient();
    connectWithIamAuth(client, sequentialTokens());
    await vi.advanceTimersByTimeAsync(0);
    client.emit("ready");

    await vi.advanceTimersByTimeAsync(IAM_CONNECTION_LIMIT_MS / 2);
    expect(client.auth).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(IAM_CONNECTION_LIMIT_MS / 2 - 1);
    expect(client.auth).toHaveBeenCalledTimes(1);
    expect(client.auth).toHaveBeenCalledWith(
      USER_ID,
      expect.stringMatching(MINTED_TOKEN)
    );

    await vi.advanceTimersByTimeAsync(IAM_CONNECTION_LIMIT_MS - 1);
    expect(client.auth).toHaveBeenCalledTimes(2);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it("reconnects a subscribed connection, which cannot re-AUTH, before ElastiCache's 12-hour limit", async () => {
    const client = new FakeIamClient();
    connectWithIamAuth(client, sequentialTokens());
    await vi.advanceTimersByTimeAsync(0);
    client.mode = "subscriber";
    client.emit("ready");

    await vi.advanceTimersByTimeAsync(IAM_CONNECTION_LIMIT_MS - 1);

    // `true` keeps ioredis reconnecting and resubscribing.
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.auth).not.toHaveBeenCalled();
  });

  it("warns when a re-AUTH is refused", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const client = new FakeIamClient();
    client.auth.mockRejectedValue(new Error("ERR Exceeded limit"));
    connectWithIamAuth(client, sequentialTokens());
    await vi.advanceTimersByTimeAsync(0);
    client.emit("ready");

    await vi.advanceTimersByTimeAsync(IAM_CONNECTION_LIMIT_MS - 1);

    expect(warn).toHaveBeenCalledWith(
      "Realtime Redis IAM re-authentication failed",
      expect.objectContaining({ event: REDIS_IAM_REAUTH_FAILED_EVENT })
    );
  });

  it("never connects a client that was closed before its first token arrived", async () => {
    let release: (token: string) => void = () => undefined;
    const client = new FakeIamClient();
    connectWithIamAuth(client, {
      userId: USER_ID,
      mintToken: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    client.emit("end");
    release("token-1");
    await vi.advanceTimersByTimeAsync(IAM_CONNECTION_LIMIT_MS);

    expect(client.connected).not.toHaveBeenCalled();
    expect(client.options.password).toBeUndefined();
  });
});

describe("connectRedis", () => {
  // Nothing listens on port 1; these check what each mode starts, not a session.
  const URL_ONLY = "redis://127.0.0.1:1";

  it("connects at once with the URL alone when no IAM auth is configured", () => {
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const client = connectRedis(URL_ONLY);
    try {
      expect(client.status).toBe("connecting");
      // ioredis's own defaults: no AUTH is sent.
      expect(client.options.username).toBeNull();
      expect(client.options.password).toBeNull();
    } finally {
      client.disconnect();
    }
  });

  it("holds the connection for the first token when IAM auth is configured, a command's included", async () => {
    const client = connectRedis(URL_ONLY, {
      iamAuth: {
        userId: USER_ID,
        mintToken: () => new Promise(() => undefined),
      },
    });
    try {
      const queued = client.zadd("rt:conn:instances", 1, "instance-1");
      queued.catch(() => undefined);
      await Promise.resolve();
      expect(client.status).toBe("wait");
      expect(client.options.username).toBe(USER_ID);
    } finally {
      client.disconnect();
    }
  });
});

describe("createRealtimeInstance", () => {
  const BASE_ENV = {
    REALTIME_TOKEN_PUBLIC_KEYS: TEST_PUBLIC_KEYS_JSON,
    REALTIME_INTERNAL_OIDC_ISSUER: OIDC_CONFIG.issuer,
    REALTIME_INTERNAL_OIDC_AUDIENCE: OIDC_CONFIG.audience,
    REALTIME_INTERNAL_OIDC_OWNER_ID: OIDC_CONFIG.ownerId,
    REALTIME_INTERNAL_OIDC_PROJECT_ID: OIDC_CONFIG.projectId,
    REALTIME_INTERNAL_OIDC_ENVIRONMENT: OIDC_CONFIG.environment,
    REDIS_URL: "rediss://cache.example.test:6379",
    AWS_REGION: "us-east-1",
  };

  async function redisOptionsOpenedFor(
    source: Record<string, string>
  ): Promise<RealtimeRedisOptions[]> {
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    const hub = new FakeBusHub();
    const clients = [
      new FakeRedisStore().client(),
      hub.publisher(),
      hub.subscriber(),
    ];
    const opened: RealtimeRedisOptions[] = [];
    const instance = createRealtimeInstance(parseRealtimeEnv(source), {
      instanceId: "instance-1",
      random: () => 0.5,
      flushTelemetry: () => Promise.resolve(),
      exit: vi.fn(),
      connectRedis: (_url, options) => {
        opened.push(options ?? {});
        return clients[opened.length - 1] as unknown as Redis;
      },
    });
    instance.stopHeartbeat();
    await instance.shutdown();
    instance.io.close();
    return opened;
  }

  it("opens every Redis connection, the bus subscriber included, with one IAM signer", async () => {
    const opened = await redisOptionsOpenedFor({
      ...BASE_ENV,
      REALTIME_REDIS_IAM_CACHE_NAME: "example-stage-realtime-cache",
      REALTIME_REDIS_IAM_USER_ID: USER_ID,
    });

    expect(opened).toHaveLength(3);
    const [shared] = opened;
    expect(shared?.iamAuth?.userId).toBe(USER_ID);
    for (const options of opened) {
      expect(options.iamAuth).toBe(shared?.iamAuth);
    }
  });

  it("opens every Redis connection with the URL alone when IAM auth is not configured", async () => {
    const opened = await redisOptionsOpenedFor(BASE_ENV);

    expect(opened).toHaveLength(3);
    for (const options of opened) {
      expect(options.iamAuth).toBeUndefined();
    }
  });
});
