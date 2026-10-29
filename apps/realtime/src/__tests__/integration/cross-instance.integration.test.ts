import { isDeepStrictEqual } from "node:util";
import { log } from "@repo/observability/log";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { type Grant, GrantAccess } from "@repo/realtime-contract/grants";
import { RealtimeInternalPath } from "@repo/realtime-contract/internal";
import {
  RealtimeEvent,
  type SignalPayload,
} from "@repo/realtime-contract/protocol";
import type pg from "pg";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthPath } from "../../http/health";
import {
  DEPENDENCY_LOST_EVENT,
  DEPENDENCY_RESTORED_EVENT,
  Dependency,
} from "../../lifecycle/readiness";
import {
  emitWithAck,
  grantedTokenFor,
  nextEvent,
  ORG_A,
  USER_A,
  USER_B,
  welcomedClient,
} from "../edge-harness";
import {
  busSubscriberOf,
  clearRevocationLog,
  connectedPg,
  type HarnessInstance,
  notify,
  notifyInTransaction,
  postInternal,
  startHarnessInstance,
  stopHarnessInstance,
  type TestSignal,
} from "./instance-harness";
import { integrationListener, integrationRedisUrl } from "./integration-env";

const DOC_1 = `comments:${ORG_A}:doc-1`;
const DOC_2 = `comments:${ORG_A}:doc-2`;
/** A kind and a signal type no code in the service names. */
const PROBE = `probe:${ORG_A}:x`;
const PROBE_TYPE = "probe.fired";
const TYPE = "comment.created";

const clients: ClientSocket[] = [];
const instances: HarnessInstance[] = [];
let api: pg.Client | undefined;
let a: HarnessInstance;
let b: HarnessInstance;

function grantsFor(org: string): Grant[] {
  return [
    { pattern: `comments:${org}:*`, access: GrantAccess.Read },
    { pattern: `probe:${org}:*`, access: GrantAccess.Read },
  ];
}

async function joinedClient(
  instance: HarnessInstance,
  org: string,
  sub: string,
  channels: string[]
): Promise<{ client: ClientSocket; events: [string, unknown][] }> {
  const { client } = await welcomedClient(
    instance.url,
    await grantedTokenFor(org, sub, grantsFor(org)),
    clients
  );
  for (const channel of channels) {
    const ack = await emitWithAck(client, RealtimeEvent.Join, { channel });
    if (!isDeepStrictEqual(ack, { ok: true, channelId: channel })) {
      throw new Error(`join of ${channel} refused: ${JSON.stringify(ack)}`);
    }
  }
  const events: [string, unknown][] = [];
  client.onAny((event: string, payload: unknown) => {
    events.push([event, payload]);
  });
  return { client, events };
}

function signalOn(channel: string, id: string): TestSignal {
  return { channel, type: TYPE, data: { id, rev: 1 } };
}

function delivered(signal: TestSignal): [string, SignalPayload] {
  return [RealtimeEvent.Signal, signal];
}

/** Commits a sentinel and waits for it: every earlier notification has been fanned out. */
async function settle(client: ClientSocket, channel: string): Promise<void> {
  const sentinel = signalOn(channel, "sentinel");
  const arrived = nextEvent<SignalPayload>(client, RealtimeEvent.Signal);
  await notifyInTransaction(requireApi(), sentinel, "commit");
  const first = await arrived;
  if (!isDeepStrictEqual(first, sentinel)) {
    throw new Error(
      `expected the sentinel first, got ${JSON.stringify(first)}`
    );
  }
}

function requireApi(): pg.Client {
  if (!api) {
    throw new Error("no Postgres client");
  }
  return api;
}

async function healthStatus(instance: HarnessInstance): Promise<number> {
  return (await fetch(instance.url + HealthPath.Health)).status;
}

describe.skipIf(!(integrationListener && integrationRedisUrl))(
  "two instances on a real Postgres and Redis",
  () => {
    beforeEach(async () => {
      if (!(integrationListener && integrationRedisUrl)) {
        return;
      }
      vi.spyOn(log, "info").mockImplementation(() => undefined);
      vi.spyOn(log, "warn").mockImplementation(() => undefined);
      api = await connectedPg(integrationListener);
      await clearRevocationLog(integrationRedisUrl);
      a = await startHarnessInstance(
        integrationRedisUrl,
        integrationListener,
        api
      );
      instances.push(a);
      b = await startHarnessInstance(
        integrationRedisUrl,
        integrationListener,
        api
      );
      instances.push(b);
    });

    afterEach(async () => {
      for (const client of clients.splice(0)) {
        client.disconnect();
      }
      for (const instance of instances.splice(0)) {
        await stopHarnessInstance(instance);
      }
      await api?.end();
      api = undefined;
      if (integrationRedisUrl) {
        await clearRevocationLog(integrationRedisUrl);
      }
      vi.restoreAllMocks();
    });

    it("delivers a committed signal to a client on another instance exactly once, and a rolled-back one never", async () => {
      const onB = await joinedClient(b, ORG_A, USER_A, [DOC_1]);
      const committed = signalOn(DOC_1, "committed");

      await notifyInTransaction(requireApi(), committed, "commit");
      await notifyInTransaction(
        requireApi(),
        signalOn(DOC_1, "rolled-back"),
        "rollback"
      );
      await settle(onB.client, DOC_1);

      expect(onB.events).toEqual([
        delivered(committed),
        delivered(signalOn(DOC_1, "sentinel")),
      ]);
    });

    it("delivers a kind and type the service has never seen with its type and data unchanged", async () => {
      const onA = await joinedClient(a, ORG_A, USER_A, [PROBE]);
      const probe: TestSignal = {
        channel: PROBE,
        type: PROBE_TYPE,
        data: { nested: { list: [1, "two", null, true] }, "odd key": "é" },
      };
      const arrived = nextEvent<SignalPayload>(
        onA.client,
        RealtimeEvent.Signal
      );

      await notify(requireApi(), probe);

      const signal = await arrived;
      expect(signal.type).toBe(PROBE_TYPE);
      expect(JSON.stringify(signal.data)).toBe(JSON.stringify(probe.data));
    });

    it("resyncs only the instance whose LISTEN connection was killed, stays healthy, and delivers again", async () => {
      const onA = await joinedClient(a, ORG_A, USER_A, [DOC_1]);
      const onB = await joinedClient(b, ORG_A, USER_B, [DOC_1]);
      const resynced = nextEvent(onA.client, RealtimeEvent.Resync);

      await requireApi().query("SELECT pg_terminate_backend($1)", [
        a.listenerPid,
      ]);
      expect(await healthStatus(a)).toBe(200);

      expect(await resynced).toEqual({});
      expect(await healthStatus(a)).toBe(200);
      expect(log.warn).toHaveBeenCalledWith(expect.any(String), {
        event: DEPENDENCY_LOST_EVENT,
        dependency: Dependency.Listener,
        cause: expect.any(String),
        degraded: true,
      });
      expect(log.info).toHaveBeenCalledWith(expect.any(String), {
        event: DEPENDENCY_RESTORED_EVENT,
        dependency: Dependency.Listener,
      });
      expect(a.readiness.isDegraded()).toBe(false);

      await settle(onA.client, DOC_1);
      await vi.waitFor(() =>
        expect(onB.events).toContainEqual(
          delivered(signalOn(DOC_1, "sentinel"))
        )
      );
      expect(onA.events.map(([event]) => event)).toEqual([
        RealtimeEvent.Resync,
        RealtimeEvent.Signal,
      ]);
      expect(onB.events.map(([event]) => event)).toEqual([
        RealtimeEvent.Signal,
      ]);
    });

    it("revokes a user through one instance on the other: that user's channels close forbidden, nobody else's", async () => {
      const revoked = await joinedClient(b, ORG_A, USER_A, [DOC_1, DOC_2]);
      const bystander = await joinedClient(b, ORG_A, USER_B, [DOC_1]);

      const response = await postInternal(a, RealtimeInternalPath.Revoke, {
        target: { userId: USER_A },
      });
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(revoked.events).toHaveLength(2));
      await settle(bystander.client, DOC_1);

      expect(revoked.events).toEqual([
        [
          RealtimeEvent.Error,
          { channel: DOC_1, code: RealtimeErrorCode.Forbidden },
        ],
        [
          RealtimeEvent.Error,
          { channel: DOC_2, code: RealtimeErrorCode.Forbidden },
        ],
      ]);
      expect(bystander.events).toEqual([
        delivered(signalOn(DOC_1, "sentinel")),
      ]);
    });

    it("applies a revoke taken while an instance's subscription was down once it resubscribes, and refuses the stale token after", async () => {
      const staleToken = await grantedTokenFor(ORG_A, USER_A, grantsFor(ORG_A));
      const revoked = await joinedClient(b, ORG_A, USER_A, [DOC_1, DOC_2]);
      const subscriber = busSubscriberOf(b);
      subscriber.disconnect();
      await vi.waitFor(() => expect(b.readiness.isDegraded()).toBe(true));

      const response = await postInternal(a, RealtimeInternalPath.Revoke, {
        target: { userId: USER_A },
      });
      expect(response.status).toBe(202);
      await subscriber.connect();

      await vi.waitFor(() => expect(revoked.events).toHaveLength(2));
      expect(revoked.events.map(([, payload]) => payload)).toEqual([
        { channel: DOC_1, code: RealtimeErrorCode.Forbidden },
        { channel: DOC_2, code: RealtimeErrorCode.Forbidden },
      ]);
      await vi.waitFor(() => expect(b.readiness.isDegraded()).toBe(false));
      const { client: reconnected } = await welcomedClient(
        b.url,
        staleToken,
        clients
      );
      expect(
        await emitWithAck(reconnected, RealtimeEvent.Join, { channel: DOC_1 })
      ).toEqual({ ok: false, code: RealtimeErrorCode.Forbidden });
    });

    it("publishes over its own connection that fails commands while down, so a refused publish is never sent later", async () => {
      const failFast = a.redisClients.filter(
        (client) => client.options.enableOfflineQueue === false
      );
      expect(failFast).toHaveLength(1);
      const [publisher] = failFast;
      expect(publisher?.options.autoResendUnfulfilledCommands).toBe(false);
      expect(publisher).not.toBe(busSubscriberOf(a));

      publisher?.disconnect();
      const probe = { channel: PROBE, type: PROBE_TYPE, data: { id: "p1" } };
      expect(
        (await postInternal(a, RealtimeInternalPath.Publish, probe)).status
      ).toBe(503);
    });

    it("publishes an unseen kind through one instance to a client on the other", async () => {
      const onB = await joinedClient(b, ORG_A, USER_A, [PROBE]);
      const probe = { channel: PROBE, type: PROBE_TYPE, data: { id: "p1" } };
      const arrived = nextEvent<SignalPayload>(
        onB.client,
        RealtimeEvent.Signal
      );

      expect(
        (await postInternal(a, RealtimeInternalPath.Publish, probe)).status
      ).toBe(202);
      expect(await arrived).toEqual(probe);
    });

    it("degrades without failing /health when the bus subscription drops, and LISTEN signals still flow", async () => {
      const onA = await joinedClient(a, ORG_A, USER_A, [DOC_1]);
      const subscriber = busSubscriberOf(a);

      subscriber.disconnect();
      await vi.waitFor(() => expect(a.readiness.isDegraded()).toBe(true));
      expect(await healthStatus(a)).toBe(200);
      await settle(onA.client, DOC_1);

      await subscriber.connect();
      await vi.waitFor(() => expect(a.readiness.isDegraded()).toBe(false));
      const published = { channel: DOC_1, type: TYPE, data: { id: "bus" } };
      const arrived = nextEvent<SignalPayload>(
        onA.client,
        RealtimeEvent.Signal
      );
      expect(
        (await postInternal(b, RealtimeInternalPath.Publish, published)).status
      ).toBe(202);
      expect(await arrived).toEqual(published);
    });
  }
);
