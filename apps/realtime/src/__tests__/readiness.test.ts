import { once } from "node:events";
import type { Server } from "node:http";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CONNECTIONS_PER_ORG,
  DEFAULT_MAX_CONNECTIONS_PER_USER,
} from "../env";
import { HealthPath } from "../http/health";
import {
  createReadiness,
  DEPENDENCY_LOST_EVENT,
  Dependency,
  type Readiness,
} from "../lifecycle/readiness";
import { HEARTBEAT_TIMEOUT_MS } from "../redis/connections";
import { bindRedisDependency } from "../redis/dependency";
import { FakeRedisStore } from "./fake-redis";
import { listenHttp, realtimeHttpServer } from "./http-harness";

let server: Server | undefined;

beforeEach(() => {
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (server) {
    server.close();
    await once(server, "close");
    server = undefined;
  }
});

async function serve(readiness: Readiness): Promise<string> {
  server = realtimeHttpServer({ readiness });
  return await listenHttp(server);
}

describe("/health and /ready", () => {
  it("serves /health at once, and /ready only after every dependency is up", async () => {
    const readiness = createReadiness([Dependency.Redis, Dependency.Listener]);
    const url = await serve(readiness);

    expect((await fetch(url + HealthPath.Health)).status).toBe(200);
    expect((await fetch(url + HealthPath.Ready)).status).toBe(503);

    readiness.markUp(Dependency.Redis);
    expect((await fetch(url + HealthPath.Ready)).status).toBe(503);

    readiness.markUp(Dependency.Listener);
    expect((await fetch(url + HealthPath.Ready)).status).toBe(200);
    expect((await fetch(`${url}/elsewhere`)).status).toBe(404);
  });

  it("stays healthy and ready after losing a dependency, and reports it degraded", async () => {
    const readiness = createReadiness([Dependency.Redis]);
    const url = await serve(readiness);
    readiness.markUp(Dependency.Redis);
    expect(readiness.isDegraded()).toBe(false);

    readiness.markDown(Dependency.Redis, "connection_closed");

    expect(readiness.isDegraded()).toBe(true);
    const health = await fetch(url + HealthPath.Health);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ degraded: true });
    expect((await fetch(url + HealthPath.Ready)).status).toBe(200);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: DEPENDENCY_LOST_EVENT,
        dependency: Dependency.Redis,
        cause: "connection_closed",
      })
    );

    readiness.markUp(Dependency.Redis);
    expect(readiness.isDegraded()).toBe(false);
  });

  it("is not degraded while a dependency has never been up", () => {
    const readiness = createReadiness([Dependency.Redis]);
    readiness.markDown(Dependency.Redis, "connection_closed");
    expect(readiness.isDegraded()).toBe(false);
    expect(readiness.isReady()).toBe(false);
  });
});

describe("Redis as a readiness dependency", () => {
  function bound() {
    const client = new FakeRedisStore().client();
    const readiness = createReadiness([Dependency.Redis]);
    const counter = bindRedisDependency(client, {
      instanceId: "i-1",
      caps: {
        perUser: DEFAULT_MAX_CONNECTIONS_PER_USER,
        perOrg: DEFAULT_MAX_CONNECTIONS_PER_ORG,
      },
      readiness,
    });
    return { client, readiness, counter };
  }

  it("becomes ready on the first heartbeat after the client connects", async () => {
    const { client, readiness } = bound();
    expect(readiness.isReady()).toBe(false);

    client.emit("ready");

    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));
  });

  it("goes degraded when the connection closes after readiness", async () => {
    const { client, readiness, counter } = bound();
    await counter.heartbeat();

    client.emit("close");

    expect(readiness.isDegraded()).toBe(true);
    expect(readiness.isReady()).toBe(true);
  });

  it("goes degraded when a stalled Redis misses the heartbeat deadline, and recovers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, readiness, counter } = bound();
    await counter.heartbeat();
    expect(readiness.isReady()).toBe(true);

    let unstall: () => void = () => undefined;
    client.stall = new Promise((resolve) => {
      unstall = resolve;
    });
    const stalled = counter.heartbeat();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    await stalled;

    expect(readiness.isDegraded()).toBe(true);
    expect(readiness.isReady()).toBe(true);

    client.stall = undefined;
    unstall();
    await counter.heartbeat();
    expect(readiness.isDegraded()).toBe(false);
  });
});
