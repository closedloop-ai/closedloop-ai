import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createSocketIoRealtimeClient,
  type RealtimeClient,
} from "@repo/realtime-client/connection";
import {
  type RealtimeChannelListener,
  RealtimeStatus,
} from "@repo/realtime-client/port";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import type { IssuedRealtimeToken } from "@repo/realtime-contract/protocol";
import { CommentSignalType } from "@repo/realtime-contract/signals";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { registerDesktopRealtimeIpcHandlers } from "../src/main/ipc/desktop-realtime-ipc.js";
import {
  type DesktopRealtimeHolder,
  DesktopRealtimeHost,
} from "../src/main/realtime/desktop-realtime-host.js";
import type { DesktopAccountAdmission } from "../src/main/session/desktop-account-admission.js";
import { CONTENT_SECURITY_POLICY_META } from "../src/shared/content-security-policy.js";
import {
  type DesktopRealtimeEvent,
  DesktopRealtimeEventKind,
} from "../src/shared/desktop-realtime-contract.js";
import { DesktopRealtimeIpcChannel } from "../src/shared/desktop-realtime-ipc-channel.js";
import { UNTRUSTED_IPC_SENDER_MESSAGE } from "../src/shared/ipc-refusal-messages.js";

const CHANNEL_ORG_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const CHANNEL = formatChannelAddress(ChannelKind.Comments, CHANNEL_ORG_ID, [
  "artifact-1",
]);
const OTHER_CHANNEL = formatChannelAddress(
  ChannelKind.Comments,
  CHANNEL_ORG_ID,
  ["artifact-2"]
);
const ACCOUNT_A: DesktopAccountAdmission = {
  userId: "user-a",
  organizationId: "org-1",
  generation: 1,
};
const ACCOUNT_B: DesktopAccountAdmission = {
  userId: "user-b",
  organizationId: "org-1",
  generation: 2,
};
const TOKEN: IssuedRealtimeToken = { token: "t", expiresAt: 1 };
const SOCKET_SCHEME = /\bwss?:\S+/g;
const SUPERSEDED = /superseded/;
const UNTRUSTED_SENDER = new RegExp(UNTRUSTED_IPC_SENDER_MESSAGE);

describe("DesktopRealtimeHost (PLN-2162 M4)", () => {
  test("builds its client in main on the first join, and the renderer's CSP excludes product realtime sockets (AC3)", () => {
    const harness = createHarness();
    assert.equal(harness.clients.length, 0);

    harness.host.join(harness.holder(1), CHANNEL);

    assert.equal(harness.clients.length, 1);
    const connectSrc = CONTENT_SECURITY_POLICY_META.split("; ").find(
      (directive) => directive.startsWith("connect-src ")
    );
    assert.ok(connectSrc, "the renderer CSP names a connect-src");
    assert.deepEqual(connectSrc.match(SOCKET_SCHEME), [
      "wss://api.liveblocks.io",
    ]);
  });

  test("two consumers in one renderer and one in a second renderer make one join (AC3)", () => {
    const harness = createHarness();

    harness.host.join(harness.holder(1), CHANNEL);
    harness.host.join(harness.holder(1), CHANNEL);
    harness.host.join(harness.holder(2), CHANNEL);

    assert.deepEqual(harness.only().joinedChannels(), [CHANNEL]);

    harness.host.leave(1, CHANNEL);
    harness.host.leave(2, CHANNEL);
    assert.equal(harness.only().leaves.length, 0, "one hold is still out");
    harness.host.leave(1, CHANNEL);
    assert.equal(harness.only().leaves.length, 1);
  });

  test("forwards the ack, signals and status to every renderer holding the channel", () => {
    const harness = createHarness();
    harness.host.join(harness.holder(1), CHANNEL);
    harness.host.join(harness.holder(2), OTHER_CHANNEL);
    const client = harness.only();

    client.setStatus(RealtimeStatus.Open);
    client.listener(CHANNEL).dataLoadedAt?.();
    client
      .listener(CHANNEL)
      .onSignal({ type: CommentSignalType.ThreadCreated, data: {} });

    assert.deepEqual(harness.sent(1), [
      {
        event: DesktopRealtimeEventKind.Status,
        status: RealtimeStatus.Connecting,
      },
      { event: DesktopRealtimeEventKind.Status, status: RealtimeStatus.Open },
      { event: DesktopRealtimeEventKind.Joined, channel: CHANNEL },
      {
        event: DesktopRealtimeEventKind.Signal,
        channel: CHANNEL,
        signal: { type: CommentSignalType.ThreadCreated, data: {} },
      },
    ]);
    assert.deepEqual(
      harness
        .sent(2)
        .filter(({ event }) => event !== DesktopRealtimeEventKind.Status),
      [],
      "a renderer holding another channel hears none of this one"
    );
    assert.deepEqual(harness.host.join(harness.holder(3), CHANNEL), {
      status: RealtimeStatus.Open,
      joined: true,
    });
  });

  test("an account change closes the client and rejoins the held channels on a new one", () => {
    const harness = createHarness();
    harness.host.join(harness.holder(1), CHANNEL);
    const first = harness.only();

    harness.admission = ACCOUNT_B;
    harness.host.reconcileAccount();

    assert.equal(first.close.mock.calls.length, 1);
    assert.equal(harness.clients.length, 2);
    assert.deepEqual(harness.clients[1]?.joinedChannels(), [CHANNEL]);
  });

  test("a sign-out closes the client and builds none", () => {
    const harness = createHarness();
    harness.host.join(harness.holder(1), CHANNEL);

    harness.admission = null;
    harness.host.reconcileAccount();

    assert.equal(harness.only().close.mock.calls.length, 1);
    assert.deepEqual(harness.sent(1).at(-1), {
      event: DesktopRealtimeEventKind.Status,
      status: RealtimeStatus.Closed,
    });
  });

  test("a client that closed itself is replaced on the next join, not reused", () => {
    const harness = createHarness();
    harness.host.join(harness.holder(1), CHANNEL);
    const first = harness.only();

    first.listener(CHANNEL).onError?.(RealtimeErrorCode.Unauthorized);
    first.setStatus(RealtimeStatus.Closed);
    harness.host.join(harness.holder(1), CHANNEL);

    assert.equal(harness.clients.length, 2);
    assert.deepEqual(first.joinedChannels(), [CHANNEL]);
    assert.deepEqual(harness.clients[1]?.joinedChannels(), [CHANNEL]);
  });

  test("releasing a renderer drops all of its holds and nobody else's", () => {
    const harness = createHarness();
    harness.host.join(harness.holder(1), CHANNEL);
    harness.host.join(harness.holder(1), CHANNEL);
    harness.host.join(harness.holder(1), OTHER_CHANNEL);
    harness.host.join(harness.holder(2), OTHER_CHANNEL);
    const client = harness.only();

    harness.host.release(1);

    assert.deepEqual(
      client.leaves,
      [CHANNEL],
      "holder 2 still holds the other"
    );
    const heardBefore = harness.sent(1).length;
    client.setStatus(RealtimeStatus.Open);
    assert.equal(harness.sent(1).length, heardBefore, "holder 1 is forgotten");
    harness.host.join(harness.holder(3), CHANNEL);
    assert.deepEqual(client.joinedChannels(), [
      CHANNEL,
      OTHER_CHANNEL,
      CHANNEL,
    ]);
  });

  test("refuses a token fetched for an account that is no longer admitted", async () => {
    let finishFetch: (token: IssuedRealtimeToken) => void = () => undefined;
    const harness = createHarness({
      fetchToken: () =>
        new Promise((resolve) => {
          finishFetch = resolve;
        }),
    });
    harness.host.join(harness.holder(1), CHANNEL);
    const pending = harness.only().getToken();

    harness.admission = ACCOUNT_B;
    finishFetch(TOKEN);

    await assert.rejects(pending, SUPERSEDED);
  });
});

describe("DesktopRealtimeHost with an idle client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("closes the client when the last channel goes, and a later join builds another", async () => {
    // A refused token fetch with no fallback URL: the client retries it on a
    // backoff for as long as it is open, which an idle host must not do.
    const fetchToken = vi.fn(() => Promise.reject(new Error("503")));
    const createClient = vi.fn(createSocketIoRealtimeClient);
    const host = new DesktopRealtimeHost({
      getAccountAdmission: () => ACCOUNT_A,
      fetchToken,
      clientVersion: "test",
      createClient,
    });
    const holder = { id: 1, send: () => undefined };

    host.join(holder, CHANNEL);
    host.join({ id: 2, send: () => undefined }, OTHER_CHANNEL);
    await vi.advanceTimersByTimeAsync(0);
    host.leave(1, CHANNEL);
    await vi.advanceTimersByTimeAsync(60_000);
    const fetchesWhileHeld = fetchToken.mock.calls.length;
    assert.ok(fetchesWhileHeld > 1, "a held channel keeps the client retrying");

    host.release(2);
    await vi.advanceTimersByTimeAsync(300_000);

    assert.equal(fetchToken.mock.calls.length, fetchesWhileHeld);

    host.join(holder, CHANNEL);
    await vi.advanceTimersByTimeAsync(0);

    assert.equal(createClient.mock.calls.length, 2);
    assert.equal(fetchToken.mock.calls.length, fetchesWhileHeld + 1);
  });
});

describe("desktop realtime IPC (PLN-2162 M4)", () => {
  test("refuses an untrusted sender", () => {
    const harness = createIpcHarness({ trusted: false });

    assert.throws(
      () =>
        harness.invoke(DesktopRealtimeIpcChannel.Join, { channel: CHANNEL }),
      UNTRUSTED_SENDER
    );
    assert.equal(harness.host.join.mock.calls.length, 0);
  });

  test("drops a payload that fails its schema", () => {
    const harness = createIpcHarness();

    assert.equal(
      harness.invoke(DesktopRealtimeIpcChannel.Join, { channel: 42 }),
      undefined
    );
    harness.invoke(DesktopRealtimeIpcChannel.Leave, { channel: "" });

    assert.equal(harness.host.join.mock.calls.length, 0);
    assert.equal(harness.host.leave.mock.calls.length, 0);
  });

  test("releases a renderer's joins when it reloads, not on an in-page navigation", () => {
    const harness = createIpcHarness();
    harness.invoke(DesktopRealtimeIpcChannel.Join, { channel: CHANNEL });

    harness.sender.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: true,
    });
    harness.sender.emit("did-start-navigation", {
      isMainFrame: false,
      isSameDocument: false,
    });
    assert.equal(harness.host.release.mock.calls.length, 0);

    harness.sender.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    assert.deepEqual(harness.host.release.mock.calls, [[harness.sender.id]]);
  });

  test("releases a renderer's joins when its process goes or it is destroyed", () => {
    const harness = createIpcHarness();
    harness.invoke(DesktopRealtimeIpcChannel.Join, { channel: CHANNEL });

    harness.sender.emit("render-process-gone", {}, { reason: "crashed" });
    harness.sender.emit("destroyed");

    assert.equal(harness.host.release.mock.calls.length, 2);
  });
});

type FakeClient = ReturnType<typeof createFakeClient>;

function createHarness(
  options: { fetchToken?: () => Promise<IssuedRealtimeToken> } = {}
) {
  const clients: FakeClient[] = [];
  const sent = new Map<number, DesktopRealtimeEvent[]>();
  const harness = {
    admission: ACCOUNT_A as DesktopAccountAdmission | null,
    clients,
    host: undefined as unknown as DesktopRealtimeHost,
    holder(id: number): DesktopRealtimeHolder {
      return {
        id,
        send: (event) => sent.set(id, [...(sent.get(id) ?? []), event]),
      };
    },
    sent: (id: number) => sent.get(id) ?? [],
    only(): FakeClient {
      const [client, ...rest] = clients;
      if (client === undefined || rest.length > 0) {
        throw new Error(`expected one client, got ${clients.length}`);
      }
      return client;
    },
  };
  harness.host = new DesktopRealtimeHost({
    getAccountAdmission: () => harness.admission,
    fetchToken: options.fetchToken ?? (() => Promise.resolve(TOKEN)),
    clientVersion: "test",
    createClient: (clientOptions) => {
      const client = createFakeClient(clientOptions.getToken);
      clients.push(client);
      return client;
    },
  });
  return harness;
}

function createFakeClient(getToken: () => Promise<IssuedRealtimeToken>) {
  let status: RealtimeStatus = RealtimeStatus.Connecting;
  const statusCallbacks = new Set<(next: RealtimeStatus) => void>();
  const joins: { channel: string; listener: RealtimeChannelListener }[] = [];
  const leaves: string[] = [];
  const client: RealtimeClient = {
    join: (channel, listener) => {
      joins.push({ channel, listener });
      return () => leaves.push(channel);
    },
    status: () => status,
    onStatus: (callback) => {
      statusCallbacks.add(callback);
      return () => statusCallbacks.delete(callback);
    },
    close: () => {
      status = RealtimeStatus.Closed;
    },
  };
  return {
    ...client,
    close: vi.fn(client.close),
    getToken,
    leaves,
    joinedChannels: () => joins.map(({ channel }) => channel),
    listener(channel: string): RealtimeChannelListener {
      const joined = joins.find((entry) => entry.channel === channel);
      if (joined === undefined) {
        throw new Error(`no join for ${channel}`);
      }
      return joined.listener;
    },
    setStatus(next: RealtimeStatus) {
      status = next;
      for (const callback of [...statusCallbacks]) {
        callback(next);
      }
    },
  };
}

class FakeWebContents extends EventEmitter {
  readonly id = 7;
}

function createIpcHarness(options: { trusted?: boolean } = {}) {
  const handlers = new Map<
    string,
    (event: { sender: WebContents }, payload?: unknown) => unknown
  >();
  const sender = new FakeWebContents();
  const host = {
    join: vi.fn((_holder: DesktopRealtimeHolder, _channel: string) => ({
      status: RealtimeStatus.Connecting,
      joined: false,
    })),
    leave: vi.fn(),
    release: vi.fn(),
  };
  registerDesktopRealtimeIpcHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    { isTrustedSender: () => options.trusted ?? true, host }
  );
  return {
    host,
    sender,
    invoke(channel: string, payload: unknown) {
      const handler = handlers.get(channel);
      if (handler === undefined) {
        throw new Error(`no handler for ${channel}`);
      }
      return handler({ sender: sender as unknown as WebContents }, payload);
    },
  };
}
