// @vitest-environment jsdom

import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import type { IssuedRealtimeToken } from "@repo/realtime-contract/protocol";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DocSyncConfig,
  DocSyncConfigContext,
} from "../client/doc-sync-config";
import {
  DocSyncAwarenessField,
  DocSyncRoom,
  type DocSyncRoomState,
  useDocSyncRoom,
} from "../client/doc-sync-room";

type FakeProviderOptions = {
  url: string;
  name: string;
  token: () => Promise<string>;
};

const { providers } = vi.hoisted(() => ({
  providers: [] as {
    options: FakeProviderOptions;
    awareness: [string, unknown][];
    emit: (event: string, payload?: unknown) => void;
    calls: string[];
    sent: string[];
    socket: { status: string };
    reconnect: () => Promise<void>;
  }[],
}));

vi.mock("@hocuspocus/provider", () => ({
  WebSocketStatus: { Connected: "connected" },
  HocuspocusProvider: class {
    readonly awareness: [string, unknown][] = [];
    readonly calls: string[] = [];
    readonly sent: string[] = [];
    readonly configuration = { websocketProvider: { status: "connected" } };
    readonly listeners = new Map<string, ((payload: unknown) => void)[]>();
    readonly options: FakeProviderOptions;
    constructor(options: FakeProviderOptions) {
      this.options = options;
      providers.push({
        options,
        awareness: this.awareness,
        calls: this.calls,
        sent: this.sent,
        socket: this.configuration.websocketProvider,
        emit: (event, payload) => this.emit(event, payload),
        // The provider's own `onOpen`: authenticate, then sync regardless.
        reconnect: async () => {
          this.emit("open");
          await this.sendToken();
          this.startSync();
        },
      });
    }
    emit(event: string, payload?: unknown) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(payload);
      }
    }
    on(event: string, listener: (payload: unknown) => void) {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
    }
    // As @hocuspocus/provider 4.7.0's `sendToken`: a token-callback rejection
    // becomes a non-`forbidden` `authenticationFailed`, and nothing is sent.
    async sendToken() {
      this.calls.push("sendToken");
      try {
        this.sent.push(await this.options.token());
      } catch (error) {
        this.emit("authenticationFailed", {
          reason: `Failed to get token during sendToken(): ${error}`,
        });
      }
    }
    startSync() {
      this.calls.push("startSync");
    }
    setAwarenessField(field: string, value: unknown) {
      this.awareness.push([field, value]);
    }
    destroy() {
      // The fake opens no socket.
    }
  },
}));

const ROOM_ID = "org-1:artifact:PRD-1";
const URL = "ws://doc-sync.example";
/** Mints another attempt cannot change: a 4xx, and a body that is not a token. */
const UNRETRYABLE_MINTS: [string, () => Promise<unknown>][] = [
  [
    "refused",
    () =>
      Promise.reject(Object.assign(new Error("status 403"), { status: 403 })),
  ],
  ["answered with a non-token", () => Promise.resolve({ token: 1 })],
];

beforeEach(() => {
  providers.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DocSyncRoom without a DocSyncConfigContext", () => {
  it("treats the missing config as transient and keeps retrying", async () => {
    let state: DocSyncRoomState | undefined;
    function Probe() {
      state = useDocSyncRoom();
      return null;
    }
    const view = render(
      <DocSyncRoom roomId={ROOM_ID}>
        <Probe />
      </DocSyncRoom>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(state).toEqual({ room: null, failed: false });
    expect(vi.getTimerCount()).toBe(1);
    expect(providers).toEqual([]);

    // The first backoff fires, fails the same way, and schedules the next.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(state).toEqual({ room: null, failed: false });
    expect(vi.getTimerCount()).toBe(1);
    expect(providers).toEqual([]);
    view.unmount();
  });
});

describe("DocSyncRoom first mint settling after unmount", () => {
  it("opens no provider for a token that arrives after unmount", async () => {
    const mint = deferred();
    const view = renderRoom(config(() => mint.promise));
    view.unmount();

    await act(async () => {
      mint.resolve(token(URL));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(providers).toEqual([]);
  });

  // Pins current behavior. This path has two `disposed` guards, one in the
  // reject handler and one in scheduleRetry, and they are redundant here:
  // deleting either one alone leaves this test green. Only deleting both
  // fails it.
  it("schedules no retry for a failure that arrives after unmount", async () => {
    const mint = deferred();
    const fetchToken = vi.fn(() => mint.promise);
    const view = renderRoom(config(fetchToken));
    view.unmount();

    await act(async () => {
      mint.reject(Object.assign(new Error("status 503"), { status: 503 }));
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("DocSyncRoom awareness", () => {
  it("writes the user field for a signed-in member", async () => {
    const view = renderRoom(
      config(() => Promise.resolve(token(URL))),
      true
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(providers).toHaveLength(1);
    expect(providers[0]?.options).toEqual(
      expect.objectContaining({ url: URL, name: ROOM_ID })
    );
    expect(providers[0]?.awareness).toEqual([
      [DocSyncAwarenessField.ReadOnly, true],
      [DocSyncAwarenessField.User, { id: "user-1", color: "red" }],
    ]);
    view.unmount();
  });

  it("writes only the read-only field when there is no signed-in user", async () => {
    const view = renderRoom({
      ...config(() => Promise.resolve(token(URL))),
      self: null,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(providers).toHaveLength(1);
    expect(providers[0]?.awareness).toEqual([
      [DocSyncAwarenessField.ReadOnly, false],
    ]);
    view.unmount();
  });
});

describe("DocSyncRoom after a refused re-authentication", () => {
  async function openRoom() {
    const view = renderRoom(config(() => Promise.resolve(token(URL))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const provider = providers[0];
    if (!provider) {
      throw new Error("no provider");
    }
    return { view, provider };
  }

  it("authenticates again after the backoff when the refusal is forbidden", async () => {
    const { view, provider } = await openRoom();

    provider.emit("authenticationFailed", {
      reason: RealtimeErrorCode.Forbidden,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(provider.calls).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(provider.calls).toEqual(["sendToken", "startSync"]);
    view.unmount();
  });

  it("does not retry a refusal for any other reason", async () => {
    const { view, provider } = await openRoom();

    provider.emit("authenticationFailed", {
      reason: RealtimeErrorCode.Unauthorized,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(provider.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
  });

  it("backs off further on each refusal, and starts over once authenticated", async () => {
    const { view, provider } = await openRoom();
    const refuse = () =>
      provider.emit("authenticationFailed", {
        reason: RealtimeErrorCode.Forbidden,
      });
    const reauthsAfter = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
      return provider.calls.filter((call) => call === "sendToken").length;
    };

    refuse();
    expect(await reauthsAfter(1000)).toBe(1);
    refuse();
    expect(await reauthsAfter(1999)).toBe(1);
    expect(await reauthsAfter(1)).toBe(2);
    provider.emit("authenticated");
    refuse();
    expect(await reauthsAfter(1000)).toBe(3);
    view.unmount();
  });

  it("leaves a socket that closed in the meantime to its own reconnect", async () => {
    const { view, provider } = await openRoom();
    provider.emit("authenticationFailed", {
      reason: RealtimeErrorCode.Forbidden,
    });
    provider.socket.status = "disconnected";

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(provider.calls).toEqual([]);
    view.unmount();
  });

  describe("when the re-mint fails", () => {
    async function openRoomRemintingWith(remint: () => Promise<unknown>) {
      const room = await mountProbedRoom(remint);
      room.provider.emit("authenticationFailed", {
        reason: RealtimeErrorCode.Forbidden,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      return room;
    }

    it.each(UNRETRYABLE_MINTS)(
      "fails the room, as on the first mint, when it is %s",
      async (_label, remint) => {
        const { view, provider, state } = await openRoomRemintingWith(remint);

        expect(provider.calls).toEqual([]);
        expect(state()?.failed).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        view.unmount();
      }
    );

    it("backs off and mints again when it fails transiently", async () => {
      let remints = 0;
      const { view, provider, fetchToken, state } = await openRoomRemintingWith(
        () => {
          remints += 1;
          return remints === 1
            ? unavailableMint()
            : Promise.resolve(token(URL));
        }
      );

      expect(provider.calls).toEqual([]);
      expect(state()?.failed).toBe(false);
      expect(vi.getTimerCount()).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(fetchToken).toHaveBeenCalledTimes(3);
      expect(provider.calls).toEqual(["sendToken", "startSync"]);
      view.unmount();
    });
  });

  it.each([
    ["a reconnect opens the socket", "open"],
    ["the room unmounts", undefined],
  ])("drops the pending retry when %s", async (_label, event) => {
    const { view, provider } = await openRoom();
    provider.emit("authenticationFailed", {
      reason: RealtimeErrorCode.Forbidden,
    });
    expect(vi.getTimerCount()).toBe(1);

    if (event === undefined) {
      view.unmount();
    } else {
      provider.emit(event);
    }

    expect(vi.getTimerCount()).toBe(0);
    if (event !== undefined) {
      view.unmount();
    }
  });
});

describe("DocSyncRoom when the provider mints for its own reconnect", () => {
  async function reconnectMintingWith(remint: () => Promise<unknown>) {
    const room = await mountProbedRoom(remint);
    await act(async () => {
      // The first connection presents the first mint's token; the reconnect
      // a revoke forces then mints through the token callback.
      await room.provider.reconnect();
      await room.provider.reconnect();
    });
    return room;
  }

  it.each(UNRETRYABLE_MINTS)(
    "fails the room when the mint is %s",
    async (_label, remint) => {
      const { view, provider, state } = await reconnectMintingWith(remint);

      expect(provider.sent).toEqual(["token-1"]);
      expect(state()?.failed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      view.unmount();
    }
  );

  it("backs off and authenticates again when the mint fails transiently", async () => {
    let remints = 0;
    const { view, provider, fetchToken, state } = await reconnectMintingWith(
      () => {
        remints += 1;
        return remints === 1
          ? unavailableMint()
          : Promise.resolve(token(URL, "token-2"));
      }
    );

    expect(state()?.failed).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(fetchToken).toHaveBeenCalledTimes(3);
    expect(provider.sent).toEqual(["token-1", "token-2"]);
    view.unmount();
  });
});

/** First mint answers a token; every later one is `remint`. */
async function mountProbedRoom(remint: () => Promise<unknown>) {
  let state: DocSyncRoomState | undefined;
  function Probe() {
    state = useDocSyncRoom();
    return null;
  }
  const fetchToken = vi
    .fn<DocSyncConfig["fetchToken"]>()
    .mockResolvedValueOnce(token(URL))
    .mockImplementation(remint);
  const view = render(
    <DocSyncConfigContext.Provider value={config(fetchToken)}>
      <DocSyncRoom roomId={ROOM_ID}>
        <Probe />
      </DocSyncRoom>
    </DocSyncConfigContext.Provider>
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const provider = providers[0];
  if (!provider) {
    throw new Error("no provider");
  }
  return { view, provider, fetchToken, state: () => state };
}

function unavailableMint(): Promise<never> {
  return Promise.reject(
    Object.assign(new Error("status 503"), { status: 503 })
  );
}

function renderRoom(value: DocSyncConfig, readOnly = false) {
  return render(
    <DocSyncConfigContext.Provider value={value}>
      <DocSyncRoom readOnly={readOnly} roomId={ROOM_ID}>
        {null}
      </DocSyncRoom>
    </DocSyncConfigContext.Provider>
  );
}

function config(fetchToken: DocSyncConfig["fetchToken"]): DocSyncConfig {
  return {
    fetchToken,
    self: { id: "user-1", color: "red" },
    resolveUser: () => undefined,
    mentionCandidates: [],
    maxMentionSuggestions: 6,
    renderMentionSuggestions: () => null,
  };
}

function token(url: string, value = "token-1"): IssuedRealtimeToken {
  return { token: value, expiresAt: 1, url };
}

function deferred() {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
