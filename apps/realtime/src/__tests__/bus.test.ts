import { isDeepStrictEqual } from "node:util";
import { InternalOidcVerdict } from "@repo/http-service/internal-oidc";
import { log } from "@repo/observability/log";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { type Grant, GrantAccess } from "@repo/realtime-contract/grants";
import {
  type BusMessage,
  BusOp,
  REALTIME_BUS_CHANNEL,
  RealtimeInternalPath,
} from "@repo/realtime-contract/internal";
import {
  type ErrorPayload,
  RealtimeEvent,
  type SignalPayload,
} from "@repo/realtime-contract/protocol";
import { createRevocations } from "@repo/realtime-contract/revocations";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUS_MESSAGE_DROPPED_EVENT,
  BUS_PUBLISH_TIMEOUT_MS,
  BUS_REPLAY_RETRY_MS,
  type BusPublisherClient,
  createRealtimeBus,
  type RealtimeBus,
} from "../bus/bus";
import { appendRevocation } from "../bus/revocation-log";
import { HealthPath } from "../http/health";
import { DeadlineExceeded } from "../lifecycle/deadline";
import {
  createReadiness,
  Dependency,
  type Readiness,
} from "../lifecycle/readiness";
import {
  type EdgeHarness,
  emitWithAck,
  grantedTokenFor,
  nextEvent,
  ORG_A,
  ORG_B,
  startComposedEdge,
  USER_A,
  USER_B,
  welcomedClient,
} from "./edge-harness";
import { FakeBusHub, type FakeBusSubscriber } from "./fake-bus";
import { realtimeHttpServer } from "./http-harness";

const DOC_1 = `comments:${ORG_A}:doc-1`;
const DOC_2 = `comments:${ORG_A}:doc-2`;
const ORG_B_DOC = `comments:${ORG_B}:doc-1`;
const TYPE = "probe.fired";
const SENTINEL = { sentinel: true };

const hub = new FakeBusHub();
const hubPublisher = hub.publisher();
let edge: EdgeHarness;
let bus: RealtimeBus;
let subscriber: FakeBusSubscriber;
let readiness: Readiness;
/** Replaces the hub's PUBLISH for one test. */
let publishOverride: BusPublisherClient["publish"] | undefined;
/** Replaces the hub's revocation log read for one test. */
let readOverride: BusPublisherClient["zrangebyscore"] | undefined;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  readiness = createReadiness([Dependency.Bus]);
  subscriber = hub.subscriber();
  publishOverride = undefined;
  readOverride = undefined;
  const revocations = createRevocations();
  bus = createRealtimeBus({
    publisher: {
      ...hubPublisher,
      publish: (channel, message) =>
        (publishOverride ?? hubPublisher.publish)(channel, message),
      zrangebyscore: (key, min, max) =>
        (readOverride ?? hubPublisher.zrangebyscore)(key, min, max),
    },
    subscriber,
    readiness,
    revocations,
  });
  edge = await startComposedEdge(
    { startBus: (io) => bus.start(io), revocations },
    realtimeHttpServer({
      readiness,
      internal: {
        verifyOidc: () =>
          Promise.resolve({ verdict: InternalOidcVerdict.Verified }),
        bus: { publish: (message) => bus.publish(message) },
      },
    })
  );
});

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
  await edge.close();
  hub.subscribers.clear();
  hub.sortedSets.clear();
  vi.restoreAllMocks();
});

async function joinedClient(
  org: string,
  sub: string,
  channels: string[]
): Promise<ClientSocket> {
  const { client } = await welcomedClient(
    edge.url,
    await grantedTokenFor(org, sub, commentGrants(org)),
    clients
  );
  for (const channel of channels) {
    await emitWithAck(client, RealtimeEvent.Join, { channel });
  }
  return client;
}

function postRevoke(userId: string): Promise<Response> {
  return fetch(edge.url + RealtimeInternalPath.Revoke, {
    method: "POST",
    headers: { authorization: "Bearer bus-test-bearer" },
    body: JSON.stringify({ target: { userId } }),
  });
}

function record(client: ClientSocket): [string, unknown][] {
  const received: [string, unknown][] = [];
  client.onAny((event: string, payload: unknown) => {
    received.push([event, payload]);
  });
  return received;
}

function publishOn(
  channel: string,
  data: Record<string, string | number | boolean> = { n: 1 }
): BusMessage {
  return { op: BusOp.Publish, channel, type: TYPE, data };
}

/** Publishes a sentinel and waits for it: every earlier message has been applied. */
async function settle(client: ClientSocket, channel: string): Promise<void> {
  const arrived = nextEvent<SignalPayload>(client, RealtimeEvent.Signal);
  await bus.publish(publishOn(channel, SENTINEL));
  const first = await arrived;
  if (!isDeepStrictEqual(first, { channel, type: TYPE, data: SENTINEL })) {
    throw new Error(
      `expected the sentinel first, got ${JSON.stringify(first)}`
    );
  }
}

describe("the bus", () => {
  it("delivers a published message as rt:signal to the channel's members only", async () => {
    const onDoc1 = await joinedClient(ORG_A, USER_A, [DOC_1]);
    const onDoc2 = await joinedClient(ORG_A, USER_B, [DOC_2]);
    const doc2Events = record(onDoc2);

    const signal = nextEvent<SignalPayload>(onDoc1, RealtimeEvent.Signal);
    await bus.publish(publishOn(DOC_1, { id: "c1" }));

    expect(await signal).toEqual({
      channel: DOC_1,
      type: TYPE,
      data: { id: "c1" },
    });
    await settle(onDoc2, DOC_2);
    expect(doc2Events).toEqual([
      [
        RealtimeEvent.Signal,
        { channel: DOC_2, type: TYPE, data: { sentinel: true } },
      ],
    ]);
  });

  it("revokes a user: every channel that user's sockets hold closes forbidden, and nobody else's", async () => {
    const revoked = await joinedClient(ORG_A, USER_A, [DOC_1, DOC_2]);
    const bystander = await joinedClient(ORG_A, USER_B, [DOC_1]);
    const revokedEvents = record(revoked);
    const bystanderEvents = record(bystander);

    await bus.publish({ op: BusOp.Revoke, target: { userId: USER_A } });
    await vi.waitFor(() => expect(revokedEvents).toHaveLength(2));

    const forbidden = (channel: string): [string, ErrorPayload] => [
      RealtimeEvent.Error,
      { channel, code: RealtimeErrorCode.Forbidden },
    ];
    expect(revokedEvents).toEqual([forbidden(DOC_1), forbidden(DOC_2)]);
    await settle(bystander, DOC_1);
    expect(bystanderEvents).toHaveLength(1);
    expect(revokedEvents).toHaveLength(2);
  });

  it("revokes a channel without touching the socket's other channels", async () => {
    const client = await joinedClient(ORG_A, USER_A, [DOC_1, DOC_2]);
    const events = record(client);

    await bus.publish({ op: BusOp.Revoke, target: { channel: DOC_1 } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await settle(client, DOC_2);

    expect(events[0]).toEqual([
      RealtimeEvent.Error,
      { channel: DOC_1, code: RealtimeErrorCode.Forbidden },
    ]);
    await bus.publish(publishOn(DOC_1));
    await settle(client, DOC_2);
    expect(events.map(([event]) => event)).toEqual([
      RealtimeEvent.Error,
      RealtimeEvent.Signal,
      RealtimeEvent.Signal,
    ]);
  });

  it("revokes an organization's channels and leaves another organization's alone", async () => {
    const inOrgA = await joinedClient(ORG_A, USER_A, [DOC_1, DOC_2]);
    const inOrgB = await joinedClient(ORG_B, USER_B, [ORG_B_DOC]);
    const orgAEvents = record(inOrgA);
    const orgBEvents = record(inOrgB);

    await bus.publish({ op: BusOp.Revoke, target: { orgId: ORG_A } });
    await vi.waitFor(() => expect(orgAEvents).toHaveLength(2));
    await settle(inOrgB, ORG_B_DOC);

    expect(orgAEvents.map(([, payload]) => payload)).toEqual([
      { channel: DOC_1, code: RealtimeErrorCode.Forbidden },
      { channel: DOC_2, code: RealtimeErrorCode.Forbidden },
    ]);
    expect(orgBEvents.map(([event]) => event)).toEqual([RealtimeEvent.Signal]);
  });

  it("drops a malformed message with a warning that carries its size, never its content", async () => {
    const client = await joinedClient(ORG_A, USER_A, [DOC_1]);
    const events = record(client);
    const secret = "do-not-log-this";

    subscriber.emit(
      "message",
      REALTIME_BUS_CHANNEL,
      JSON.stringify({ op: BusOp.Publish, channel: DOC_1, data: secret })
    );
    await settle(client, DOC_1);

    expect(events).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), {
      event: BUS_MESSAGE_DROPPED_EVENT,
      bytes: expect.any(Number),
    });
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(
      secret
    );
  });

  it("degrades on losing the subscription after readiness, and /health stays 200", async () => {
    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));

    subscriber.disconnect();
    expect(readiness.isDegraded()).toBe(true);
    expect((await fetch(edge.url + HealthPath.Health)).status).toBe(200);
    expect((await fetch(edge.url + HealthPath.Ready)).status).toBe(200);

    subscriber.reconnect();
    await vi.waitFor(() => expect(readiness.isDegraded()).toBe(false));
    expect(subscriber.channels.has(REALTIME_BUS_CHANNEL)).toBe(true);
  });

  it("answers /internal/revoke 202 while this instance's subscription is down, reaches the other instances, and applies it here once it subscribes again", async () => {
    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));
    const revoked = await joinedClient(ORG_A, USER_A, [DOC_1]);
    const events = record(revoked);
    const heard = nextBusMessage(await anotherInstance());
    subscriber.disconnect();

    expect((await postRevoke(USER_A)).status).toBe(202);
    expect(await heard).toEqual({
      op: BusOp.Revoke,
      target: { userId: USER_A },
    });

    subscriber.reconnect();
    await vi.waitFor(() => expect(events).toEqual([forbiddenOn(DOC_1)]));
  });

  it("publishes to the other instances while this instance's subscription is down", async () => {
    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));
    const heard = nextBusMessage(await anotherInstance());
    subscriber.disconnect();

    await bus.publish(publishOn(DOC_1, { id: "c1" }));

    expect(await heard).toEqual(publishOn(DOC_1, { id: "c1" }));
  });

  it("answers /internal/revoke 202 while subscribed even when PUBLISH counts zero receivers, as a cluster node can", async () => {
    const revoked = await joinedClient(ORG_A, USER_A, [DOC_1]);
    const events = record(revoked);
    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));
    publishOverride = (channel, message) =>
      hubPublisher.publish(channel, message).then(() => 0);

    expect((await postRevoke(USER_A)).status).toBe(202);
    await vi.waitFor(() => expect(events).toHaveLength(1));
  });

  it("refuses a rejoin, and a join from a new connection, under a token issued before the revoke", async () => {
    const staleToken = await grantedTokenFor(
      ORG_A,
      USER_A,
      commentGrants(ORG_A)
    );
    const revoked = await joinedClient(ORG_A, USER_A, [DOC_1]);
    const events = record(revoked);

    await bus.publish({ op: BusOp.Revoke, target: { userId: USER_A } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const { client: reconnected } = await welcomedClient(
      edge.url,
      staleToken,
      clients
    );

    const refused = { ok: false, code: RealtimeErrorCode.Forbidden };
    expect(
      await emitWithAck(revoked, RealtimeEvent.Join, { channel: DOC_1 })
    ).toEqual(refused);
    expect(
      await emitWithAck(reconnected, RealtimeEvent.Join, { channel: DOC_2 })
    ).toEqual(refused);
  });

  it("lets a revoked socket rejoin once it refreshes to a token issued after the revoke", async () => {
    const revoked = await joinedClient(ORG_A, USER_A, [DOC_1]);
    const events = record(revoked);
    await bus.publish({ op: BusOp.Revoke, target: { channel: DOC_1 } });
    await vi.waitFor(() => expect(events).toHaveLength(1));

    const refreshed = await emitWithAck(revoked, RealtimeEvent.Refresh, {
      token: await tokenIssuedLater(ORG_A, USER_A),
    });

    expect(refreshed).toMatchObject({ ok: true });
    expect(
      await emitWithAck(revoked, RealtimeEvent.Join, { channel: DOC_1 })
    ).toEqual({ ok: true, channelId: DOC_1 });
  });

  it("applies a revoke taken while its subscription was down once it subscribes again", async () => {
    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));
    const revoked = await joinedClient(ORG_A, USER_A, [DOC_1, DOC_2]);
    const bystander = await joinedClient(ORG_A, USER_B, [DOC_1]);
    const revokedEvents = record(revoked);
    const bystanderEvents = record(bystander);
    subscriber.disconnect();

    // Another instance takes the revoke: its PUBLISH reaches no one here.
    await appendRevocation(hubPublisher, {
      target: { userId: USER_A },
      at: Date.now(),
    });
    subscriber.reconnect();

    await vi.waitFor(() => expect(revokedEvents).toHaveLength(2));
    expect(revokedEvents).toEqual([forbiddenOn(DOC_1), forbiddenOn(DOC_2)]);
    await vi.waitFor(() => expect(readiness.isDegraded()).toBe(false));
    await settle(bystander, DOC_1);
    expect(bystanderEvents.map(([event]) => event)).toEqual([
      RealtimeEvent.Signal,
    ]);
  });

  it("stays degraded while the revocation log cannot be read after a resubscribe, and retries it", async () => {
    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));
    subscriber.disconnect();
    const read = vi.fn(() => Promise.reject(new Error("log unreadable")));
    readOverride = read;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    subscriber.reconnect();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(readiness.isDegraded()).toBe(true);

    readOverride = undefined;
    await vi.advanceTimersByTimeAsync(BUS_REPLAY_RETRY_MS);
    await vi.waitFor(() => expect(readiness.isDegraded()).toBe(false));
  });

  it("ignores a message that arrives on any channel other than the bus channel", async () => {
    const client = await joinedClient(ORG_A, USER_A, [DOC_1]);
    const events = record(client);

    subscriber.emit(
      "message",
      "some-other-channel",
      JSON.stringify(publishOn(DOC_1, { id: "elsewhere" }))
    );
    await settle(client, DOC_1);

    expect(events).toEqual([
      [RealtimeEvent.Signal, { channel: DOC_1, type: TYPE, data: SENTINEL }],
    ]);
  });

  it("does not mark the bus up when a replay finishes after its subscription closed", async () => {
    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));
    subscriber.disconnect();
    let finishRead: ((members: string[]) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          finishRead = resolve;
        })
    );
    readOverride = read;

    subscriber.reconnect();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    subscriber.disconnect();
    finishRead?.([]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(readiness.isDegraded()).toBe(true);
  });

  it("does not schedule a retry when a replay fails after its subscription closed", async () => {
    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));
    subscriber.disconnect();
    let failRead: ((error: Error) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<string[]>((_resolve, reject) => {
          failRead = reject;
        })
    );
    readOverride = read;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    subscriber.reconnect();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    subscriber.disconnect();
    failRead?.(new Error("log unreadable"));
    await vi.advanceTimersByTimeAsync(BUS_REPLAY_RETRY_MS * 2);

    expect(read).toHaveBeenCalledOnce();
  });

  it("rejects a publish Redis does not take within the deadline", async () => {
    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));
    publishOverride = () => new Promise<number>(() => undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const rejected = expect(
      bus.publish(publishOn(DOC_1))
    ).rejects.toBeInstanceOf(DeadlineExceeded);
    await vi.advanceTimersByTimeAsync(BUS_PUBLISH_TIMEOUT_MS);
    await rejected;
  });
});

/** A second subscriber on the hub, standing in for another instance. */
async function anotherInstance(): Promise<FakeBusSubscriber> {
  const other = hub.subscriber();
  await other.subscribe(REALTIME_BUS_CHANNEL);
  return other;
}

function nextBusMessage(other: FakeBusSubscriber): Promise<unknown> {
  return new Promise((resolve) => {
    other.once("message", (_channel: string, raw: string) =>
      resolve(JSON.parse(raw))
    );
  });
}

function commentGrants(org: string): Grant[] {
  return [{ pattern: `comments:${org}:*`, access: GrantAccess.Read }];
}

function forbiddenOn(channel: string): [string, ErrorPayload] {
  return [RealtimeEvent.Error, { channel, code: RealtimeErrorCode.Forbidden }];
}

/** Issued with the clock pinned ahead, so its `iat` is past any revoke taken now. */
async function tokenIssuedLater(org: string, sub: string): Promise<string> {
  const later = Date.now() + TOKEN_ISSUED_LATER_BY_MS;
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(later);
    return await grantedTokenFor(org, sub, commentGrants(org));
  } finally {
    vi.useRealTimers();
  }
}

const TOKEN_ISSUED_LATER_BY_MS = 2000;
