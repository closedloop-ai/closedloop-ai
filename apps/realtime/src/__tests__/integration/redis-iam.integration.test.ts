import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { log } from "@repo/observability/log";
import type { Redis } from "@repo/redis";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { connectRedis } from "../../redis/dependency";
import { integrationRedisUrl } from "./integration-env";

/**
 * A password-auth ACL user stands in for the IAM user: ElastiCache checks the
 * token, and what this proves is that ioredis sends AUTH as the configured
 * user with the minted token, which it reads at connect time.
 */
const IAM_STAND_IN_USER = `realtime-iam-stand-in-${randomUUID()}`;
const MINTED_TOKEN = randomUUID();

describe.skipIf(!integrationRedisUrl)("Redis IAM auth on a real Redis", () => {
  const redisUrl = integrationRedisUrl ?? "";
  const clients: Redis[] = [];

  const open = (client: Redis): Redis => {
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    const admin = connectRedis(redisUrl);
    await admin.call(
      "ACL",
      "SETUSER",
      IAM_STAND_IN_USER,
      "reset",
      "on",
      `>${MINTED_TOKEN}`,
      "~*",
      "&*",
      "+@all"
    );
    admin.disconnect();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      if (client.status !== "end") {
        const ended = once(client, "end");
        client.disconnect();
        await ended;
      }
    }
  });

  afterAll(async () => {
    const admin = connectRedis(redisUrl);
    await admin.call("ACL", "DELUSER", IAM_STAND_IN_USER);
    admin.disconnect();
  });

  it("authenticates as the configured user with the minted token, where the URL alone is `default`", async () => {
    vi.spyOn(log, "info").mockImplementation(() => undefined);
    let mint: (token: string) => void = () => undefined;
    const iam = open(
      connectRedis(redisUrl, {
        iamAuth: {
          userId: IAM_STAND_IN_USER,
          mintToken: () =>
            new Promise((resolve) => {
              mint = resolve;
            }),
        },
      })
    );
    // Sent while the first token is still being minted, as the heartbeat is at boot.
    const whoAmI = iam.call("ACL", "WHOAMI");
    const urlOnly = open(connectRedis(redisUrl));
    expect(await urlOnly.call("ACL", "WHOAMI")).toBe("default");

    mint(MINTED_TOKEN);
    expect(await whoAmI).toBe(IAM_STAND_IN_USER);

    // A subscriber's renewal before ElastiCache's 12-hour limit: ioredis reconnects and AUTHs again.
    const renewed = once(iam, "ready");
    iam.disconnect(true);
    await renewed;
    expect(await iam.call("ACL", "WHOAMI")).toBe(IAM_STAND_IN_USER);
  });
});
