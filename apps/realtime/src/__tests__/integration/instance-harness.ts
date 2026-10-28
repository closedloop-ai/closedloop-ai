import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createOidcFixture,
  OIDC_CONFIG,
  OIDC_JWKS_URL,
} from "@repo/http-service/test-support/oidc-fixture";
import type { RealtimeInternalPath } from "@repo/realtime-contract/internal";
import {
  REALTIME_SIGNAL_CHANNEL,
  type SignalEnvelope,
  serializeSignalEnvelope,
} from "@repo/realtime-contract/signal";
import type { Redis } from "@repo/redis";
import pg from "pg";
import { type Mock, vi } from "vitest";
import { REVOCATION_LOG_KEY } from "../../bus/revocation-log";
import { parseRealtimeEnv } from "../../env";
import { createRealtimeInstance, type RealtimeInstance } from "../../instance";
import { connectRedis } from "../../redis/dependency";
import {
  ListenerAuth,
  type ListenerConnectionConfig,
} from "../../signal/listener-config";
import { listenerClientConfig } from "../../signal/pg-connection";
import {
  ALLOWED_ORIGIN,
  type EdgeHarness,
  listenEdge,
  TEST_PUBLIC_KEYS_JSON,
} from "../edge-harness";

export type TestSignal = {
  channel: string;
  type: string;
  data: SignalEnvelope["d"];
};

/** ISS-11966: `/internal/*` bearers verify against this fixture's JWKS. */
const oidc = await createOidcFixture();

export type HarnessInstance = RealtimeInstance &
  EdgeHarness & {
    /** Every Redis connection the instance opened, in order. */
    redisClients: Redis[];
    /** The backend pid of this instance's LISTEN connection, once it is up. */
    listenerPid: number;
    /** The issuer's JWKS endpoint, as the instance's OIDC verifier fetches it. */
    jwks: Mock;
  };

/**
 * PLN-2105 step 8: one realtime instance wired exactly as `src/index.ts` wires
 * it (`createRealtimeInstance`), against the real Redis and Postgres, served
 * on an ephemeral port. Resolves once `/ready` would answer 200. `env` adds
 * to or overrides the environment it parses.
 */
export async function startHarnessInstance(
  redisUrl: string,
  listener: ListenerConnectionConfig,
  admin: pg.Client,
  env: Record<string, string> = {}
): Promise<HarnessInstance> {
  const before = new Set(await listenerPids(admin, listener));
  const redisClients: Redis[] = [];
  const parsed = parseRealtimeEnv({
    REALTIME_TOKEN_PUBLIC_KEYS: TEST_PUBLIC_KEYS_JSON,
    REALTIME_INTERNAL_OIDC_ISSUER: OIDC_CONFIG.issuer,
    REALTIME_INTERNAL_OIDC_AUDIENCE: OIDC_CONFIG.audience,
    REALTIME_INTERNAL_OIDC_OWNER_ID: OIDC_CONFIG.ownerId,
    REALTIME_INTERNAL_OIDC_PROJECT_ID: OIDC_CONFIG.projectId,
    REALTIME_INTERNAL_OIDC_ENVIRONMENT: OIDC_CONFIG.environment,
    REDIS_URL: redisUrl,
    REALTIME_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    ...listenerEnv(listener),
    ...env,
  });
  const jwks = oidc.servingJwks();
  // The verifier keeps the `fetch` it was built with, so the global can be
  // put back as soon as the instance exists. A plain function, not a spy: a
  // restored spy would call the real fetch from then on.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    String(input) === OIDC_JWKS_URL
      ? jwks(String(input), init as never)
      : realFetch(input, init);
  let instance: RealtimeInstance;
  try {
    instance = createRealtimeInstance(parsed, {
      instanceId: randomUUID(),
      random: Math.random,
      flushTelemetry: async () => undefined,
      exit: vi.fn(),
      connectRedis: (url, options) => {
        const client = connectRedis(url, options);
        redisClients.push(client);
        return client;
      },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  const edge = await listenEdge(instance.httpServer, instance.io);
  await vi.waitFor(() => {
    if (!instance.readiness.isReady()) {
      throw new Error("instance not ready");
    }
  }, READY_WAIT);
  const [listenerPid] = (await listenerPids(admin, listener)).filter(
    (pid) => !before.has(pid)
  );
  if (listenerPid === undefined) {
    throw new Error("no new LISTEN backend");
  }
  return { ...instance, ...edge, redisClients, listenerPid, jwks };
}

export async function stopHarnessInstance(
  instance: HarnessInstance
): Promise<void> {
  instance.stopHeartbeat();
  await instance.shutdown();
  await instance.close();
  for (const client of instance.redisClients) {
    if (client.status !== "end") {
      const ended = once(client, "end");
      client.disconnect();
      await ended;
    }
  }
}

/**
 * Every instance replays the shared revocation log when it subscribes, so a
 * revoke one test takes would bind the next test's tokens.
 */
export async function clearRevocationLog(redisUrl: string): Promise<void> {
  const client = connectRedis(redisUrl);
  try {
    await client.del(REVOCATION_LOG_KEY);
  } finally {
    client.disconnect();
  }
}

/** The instance's bus subscriber: the one connection in subscriber mode. */
export function busSubscriberOf(instance: HarnessInstance): Redis {
  const subscriber = instance.redisClients.find(
    (client) => client.mode === "subscriber"
  );
  if (!subscriber) {
    throw new Error("no subscribed Redis connection");
  }
  return subscriber;
}

/** Plays `apps/api`: one transaction that issues `emitSignal`'s statement, then commits or rolls back. */
export async function notifyInTransaction(
  api: pg.Client,
  signal: TestSignal,
  outcome: "commit" | "rollback"
): Promise<void> {
  await api.query("BEGIN");
  try {
    await notify(api, signal);
  } finally {
    await api.query(outcome === "commit" ? "COMMIT" : "ROLLBACK");
  }
}

export async function notify(
  api: pg.Client,
  signal: TestSignal
): Promise<void> {
  const payload = serializeSignalEnvelope({
    c: signal.channel,
    t: signal.type,
    d: signal.data,
    ts: Date.now(),
  });
  await api.query("SELECT pg_notify($1, $2)", [
    REALTIME_SIGNAL_CHANNEL,
    payload,
  ]);
}

/** Sends `apps/api`'s OIDC bearer unless `credentials` replaces it. */
export async function postInternal(
  instance: EdgeHarness,
  path: RealtimeInternalPath,
  body: unknown,
  credentials?: Record<string, string>
): Promise<Response> {
  return fetch(instance.url + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credentials ?? { authorization: `Bearer ${await oidc.mint()}` }),
    },
    body: JSON.stringify(body),
  });
}

/** A plain connection for the test's own statements, never mistaken for a listener. */
export async function connectedPg(
  listener: ListenerConnectionConfig
): Promise<pg.Client> {
  const client = new pg.Client({
    ...listenerClientConfig(listener),
    application_name: TEST_APPLICATION_NAME,
  });
  await client.connect();
  return client;
}

async function listenerPids(
  admin: pg.Client,
  listener: ListenerConnectionConfig
): Promise<number[]> {
  const { rows } = await admin.query<{ pid: number }>(
    "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database()",
    [listenerClientConfig(listener).application_name]
  );
  return rows.map((row) => row.pid);
}

function listenerEnv(
  listener: ListenerConnectionConfig
): Record<string, string> {
  if (listener.auth !== ListenerAuth.Password) {
    throw new Error("the harness LISTENs with password auth");
  }
  return {
    REALTIME_PG_AUTH: listener.auth,
    REALTIME_PG_HOST: listener.host,
    REALTIME_PG_PORT: String(listener.port),
    REALTIME_PG_USER: listener.user,
    REALTIME_PG_PASSWORD: listener.password,
    REALTIME_PG_DATABASE: listener.database,
  };
}

const READY_WAIT = { timeout: 10_000, interval: 50 };
const TEST_APPLICATION_NAME = "realtime-integration-test";
