/**
 * @vitest-environment node
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer, connect as dial, type Socket } from "node:net";
import { log } from "@repo/observability/log";
import {
  createSocketIoRealtimeClient,
  type RealtimeClient,
} from "@repo/realtime-client/connection";
import {
  type RealtimeSignal,
  RealtimeStatus,
} from "@repo/realtime-client/port";
import { type Grant, GrantAccess } from "@repo/realtime-contract/grants";
import { RealtimeEvent } from "@repo/realtime-contract/protocol";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrainTrigger } from "../../lifecycle/drain";
import { grantedTokenFor, ORG_A, USER_A } from "../edge-harness";
import {
  clearRevocationLog,
  connectedPg,
  type HarnessInstance,
  notifyInTransaction,
  startHarnessInstance,
  stopHarnessInstance,
  type TestSignal,
} from "./instance-harness";
import { integrationListener, integrationRedisUrl } from "./integration-env";

const DOC = `comments:${ORG_A}:doc-1`;
const TYPE = "comment.created";
const GRANTS: Grant[] = [
  { pattern: `comments:${ORG_A}:*`, access: GrantAccess.Read },
];
/** Short, so the drain hint's `afterMs` stays inside the test timeout. */
const DRAIN_WINDOW_MS = "2000";

const clients: RealtimeClient[] = [];
const instances: HarnessInstance[] = [];
const teardowns: (() => Promise<void>)[] = [];
let api: pg.Client | undefined;
let a: HarnessInstance;
let b: HarnessInstance;

/**
 * PLN-2106 step 7 (ISS-11211 AC 6): `@repo/realtime-client` as the desktop
 * main process hosts it, under Node with the real socket.io-client, against
 * two real instances on a real Postgres and Redis.
 */
describe.skipIf(!(integrationListener && integrationRedisUrl))(
  "the realtime client under Node against real instances",
  () => {
    beforeEach(async () => {
      if (!(integrationListener && integrationRedisUrl)) {
        return;
      }
      vi.spyOn(log, "info").mockImplementation(() => undefined);
      vi.spyOn(log, "warn").mockImplementation(() => undefined);
      api = await connectedPg(integrationListener);
      await clearRevocationLog(integrationRedisUrl);
      const env = { DRAIN_WINDOW_MS };
      a = await startHarnessInstance(
        integrationRedisUrl,
        integrationListener,
        api,
        env
      );
      instances.push(a);
      b = await startHarnessInstance(
        integrationRedisUrl,
        integrationListener,
        api,
        env
      );
      instances.push(b);
    });

    afterEach(async () => {
      for (const client of clients.splice(0)) {
        client.close();
      }
      for (const teardown of teardowns.splice(0)) {
        await teardown();
      }
      for (const instance of instances.splice(0)) {
        await stopHarnessInstance(instance);
      }
      await api?.end();
      api = undefined;
      vi.restoreAllMocks();
    });

    it("receives a committed signal on a joined channel", async () => {
      const consumer = startConsumer(toServiceUrl(a.url));
      await consumer.resynced(1);
      const committed = signal("committed");

      await notifyInTransaction(requireApi(), committed, "commit");

      await expect(consumer.signalled(1)).resolves.toEqual([
        { type: committed.type, data: committed.data },
      ]);
    });

    it("on a drain, reconnects through the balancer, rejoins once on the other instance and resyncs", async () => {
      let target = a;
      const balancerUrl = await startBalancer(() => target);
      const joinsOnB: string[] = [];
      b.io.on("connection", (socket) => {
        socket.onAny((event: string) => {
          if (event === RealtimeEvent.Join) {
            joinsOnB.push(socket.id);
          }
        });
      });
      const consumer = startConsumer(balancerUrl);
      await consumer.resynced(1);

      target = b;
      a.drain.start(DrainTrigger.TaskStopping);
      await consumer.resynced(2);
      const after = signal("after-drain");
      const sentinel = signal("sentinel");
      await notifyInTransaction(requireApi(), after, "commit");
      await notifyInTransaction(requireApi(), sentinel, "commit");

      await expect(consumer.signalled(2)).resolves.toEqual([
        { type: after.type, data: after.data },
        { type: sentinel.type, data: sentinel.data },
      ]);
      expect(joinsOnB).toHaveLength(1);
      expect(consumer.client.status()).toBe(RealtimeStatus.Open);
    });
  }
);

/** A Node client on `url`, joined to `DOC`. */
function startConsumer(url: string) {
  const client = createSocketIoRealtimeClient({
    url,
    getToken: async () => ({
      token: await grantedTokenFor(ORG_A, USER_A, GRANTS),
      expiresAt: Date.now() + 600_000,
    }),
    clientVersion: "node-host/1.0.0",
  });
  clients.push(client);
  const signals: RealtimeSignal[] = [];
  let resyncs = 0;
  client.join(DOC, {
    onSignal: (received) => signals.push(received),
    onResync: () => {
      resyncs += 1;
    },
  });
  return {
    client,
    resynced: (count: number) =>
      vi.waitFor(() => {
        if (resyncs < count) {
          throw new Error(`${resyncs} of ${count} resyncs`);
        }
      }, CLIENT_WAIT),
    signalled: async (count: number) => {
      await vi.waitFor(() => {
        if (signals.length < count) {
          throw new Error(`${signals.length} of ${count} signals`);
        }
      }, CLIENT_WAIT);
      return signals;
    },
  };
}

/**
 * Plays the load balancer in front of the service: one URL, each new TCP
 * connection forwarded to whichever instance `target()` names then.
 */
async function startBalancer(target: () => HarnessInstance): Promise<string> {
  const open = new Set<Socket>();
  const server = createServer((inbound) => {
    const outbound = dial(Number(new URL(target().url).port), "127.0.0.1");
    for (const socket of [inbound, outbound]) {
      open.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        open.delete(socket);
        inbound.destroy();
        outbound.destroy();
      });
    }
    inbound.pipe(outbound);
    outbound.pipe(inbound);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  teardowns.push(async () => {
    for (const socket of open) {
      socket.destroy();
    }
    server.close();
    await once(server, "close");
  });
  const { port } = server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
}

function toServiceUrl(harnessUrl: string): string {
  return harnessUrl.replace(HTTP_SCHEME, "ws");
}

function signal(id: string): TestSignal {
  return { channel: DOC, type: TYPE, data: { id, rev: 1 } };
}

function requireApi(): pg.Client {
  if (!api) {
    throw new Error("no Postgres client");
  }
  return api;
}

const HTTP_SCHEME = /^http/;
const CLIENT_WAIT = { timeout: 10_000, interval: 25 };
