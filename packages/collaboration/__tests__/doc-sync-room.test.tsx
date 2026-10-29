// @vitest-environment jsdom

import { WebSocketStatus } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import {
  DocSyncFirstOpenSeed,
  type DocSyncTokenResponse,
  type IssuedRealtimeToken,
} from "@repo/realtime-contract/protocol";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { XmlElement, XmlText } from "yjs";
import {
  type DocSyncConfig,
  DocSyncConfigContext,
} from "../client/doc-sync-config";
import { type DocSyncPeers, useDocSyncPeers } from "../client/doc-sync-peers";
import {
  DocSyncRoom,
  type DocSyncRoomState,
  useDocSyncIsSynced,
  useDocSyncRoom,
  useIsOnDocSync,
} from "../client/doc-sync-room";

const ROOM_ID = "org-1:artifact:PRD-1";
const WAIT = { timeout: 5000 };

let server: Server | undefined;

// jsdom replaces `Event`, which Node's own WebSocket then refuses to dispatch;
// `ws` brings its own event classes.
beforeEach(() => {
  vi.stubGlobal("WebSocket", NodeWebSocket);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await server?.destroy();
  server = undefined;
});

describe("DocSyncRoom against a real Hocuspocus server", () => {
  it("syncs two rooms on one document", async () => {
    const url = await startServer();
    const first = mountRoom({ url, userId: "user-1" });
    const second = mountRoom({ url, userId: "user-2" });
    await waitFor(() => expect(first.synced()).toBe(true), WAIT);
    await waitFor(() => expect(second.synced()).toBe(true), WAIT);

    first.ydoc().getMap("probe").set("text", "hello");

    await waitFor(
      () => expect(second.ydoc().getMap("probe").get("text")).toBe("hello"),
      WAIT
    );
    first.unmount();
    second.unmount();
  });

  it("shows a peer who joins later, without remounting", async () => {
    const url = await startServer();
    const first = mountRoom({ url, userId: "user-1" });
    await waitFor(() => expect(first.synced()).toBe(true), WAIT);
    expect(first.peers().others).toEqual([]);

    const second = mountRoom({ url, userId: "user-2", readOnly: true });

    await waitFor(
      () =>
        expect(first.peers().others).toEqual([
          expect.objectContaining({
            info: expect.objectContaining({ name: "Name of user-2" }),
            presence: { readOnly: true },
          }),
        ]),
      WAIT
    );
    expect(first.peers().self?.info.name).toBe("Name of user-1");
    expect(first.mounts).toBe(1);
    first.unmount();
    second.unmount();
  });

  it("mints a new token when the provider reconnects", async () => {
    const url = await startServer();
    const room = mountRoom({ url, userId: "user-1" });
    await waitFor(() => expect(room.synced()).toBe(true), WAIT);
    expect(room.fetchToken).toHaveBeenCalledTimes(1);

    room.handle().provider.configuration.websocketProvider.webSocket?.close();

    await waitFor(() => expect(room.fetchToken).toHaveBeenCalledTimes(2), {
      timeout: 10_000,
    });
    expect(room.fetchToken).toHaveBeenLastCalledWith(ROOM_ID);
    room.unmount();
  }, 15_000);

  it("destroys the provider and the Y.Doc on unmount", async () => {
    const url = await startServer();
    const room = mountRoom({ url, userId: "user-1" });
    await waitFor(() => expect(room.synced()).toBe(true), WAIT);
    const handle = room.handle();
    const destroyProvider = vi.spyOn(handle.provider, "destroy");
    const destroyDoc = vi.spyOn(handle.ydoc, "destroy");

    room.unmount();

    expect(destroyProvider).toHaveBeenCalledTimes(1);
    expect(destroyDoc).toHaveBeenCalledTimes(1);
  });
});

describe("DocSyncRoom with an unconfirmed first-open seed (ISS-12508 OQ-3)", () => {
  it("reports failed, never synced, and disconnects when the first sync finds the document empty", async () => {
    const url = await startServer();
    const room = mountRoom({
      url,
      userId: "user-1",
      firstOpenSeed: DocSyncFirstOpenSeed.Unconfirmed,
    });
    await waitFor(() => expect(room.failed()).toBe(true), WAIT);

    const { provider } = room.handle();
    expect(room.everSynced()).toBe(false);
    await waitFor(
      () =>
        expect(provider.configuration.websocketProvider.status).toBe(
          WebSocketStatus.Disconnected
        ),
      WAIT
    );
    room.unmount();
  });

  it("syncs normally when the document already has content", async () => {
    const url = await startServer();
    const writer = mountRoom({ url, userId: "user-1" });
    await waitFor(() => expect(writer.synced()).toBe(true), WAIT);
    const paragraph = new XmlElement("paragraph");
    paragraph.insert(0, [new XmlText("kept")]);
    writer
      .ydoc()
      .getXmlFragment(DOCUMENT_FRAGMENT_FIELD)
      .insert(0, [paragraph]);

    const reader = mountRoom({
      url,
      userId: "user-2",
      firstOpenSeed: DocSyncFirstOpenSeed.Unconfirmed,
    });

    await waitFor(() => expect(reader.synced()).toBe(true), WAIT);
    expect(reader.failed()).toBe(false);
    writer.unmount();
    reader.unmount();
  });

  it("syncs an empty document normally when the seed was not reported unconfirmed", async () => {
    const url = await startServer();
    const room = mountRoom({ url, userId: "user-1" });

    await waitFor(() => expect(room.synced()).toBe(true), WAIT);
    expect(room.failed()).toBe(false);
    room.unmount();
  });
});

describe("DocSyncRoom first mint", () => {
  it("reports connecting, not absent, while the first token is pending", () => {
    const states: (DocSyncRoomState | undefined)[] = [];
    function Probe() {
      states.push(useDocSyncRoom());
      return null;
    }
    const config = makeConfig("user-1", () => new Promise(() => undefined));
    const view = render(
      <>
        <Probe />
        <DocSyncConfigContext.Provider value={config}>
          <DocSyncRoom roomId={ROOM_ID}>
            <Probe />
          </DocSyncRoom>
        </DocSyncConfigContext.Provider>
      </>
    );
    expect(states).toEqual([undefined, { room: null, failed: false }]);
    view.unmount();
  });

  it.each([
    ["a 403", () => Promise.reject(answeredFailure(403))],
    ["a response that is not a token", () => Promise.resolve({ nope: 1 })],
  ])(
    "stops after %s on the first mint and reports failed",
    async (_label, mintResult) => {
      vi.useFakeTimers();
      const fetchToken = vi.fn(mintResult);
      const view = renderFirstMint(fetchToken);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(fetchToken).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(view.state()).toEqual({ room: null, failed: true });
      view.unmount();
    }
  );

  it.each([
    ["a 503", 503],
    ["a network failure", 0],
  ])(
    "backs off and retries after %s on the first mint",
    async (_label, status) => {
      vi.useFakeTimers();
      const fetchToken = vi.fn(() => Promise.reject(answeredFailure(status)));
      const view = renderFirstMint(fetchToken);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(fetchToken).toHaveBeenCalledTimes(2);
      expect(view.state()).toEqual({ room: null, failed: false });
      view.unmount();
    }
  );

  it("retries a failed first mint and clears the timer on unmount", async () => {
    vi.useFakeTimers();
    const fetchToken = vi.fn(() => Promise.reject(new Error("offline")));
    const view = render(
      <DocSyncConfigContext.Provider value={makeConfig("user-1", fetchToken)}>
        <DocSyncRoom roomId={ROOM_ID}>{null}</DocSyncRoom>
      </DocSyncConfigContext.Provider>
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchToken).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchToken).toHaveBeenCalledTimes(2);

    view.unmount();

    // The pending 2s retry would mint a third time had unmount not cleared it.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("retries when the token response names no service URL", async () => {
    vi.useFakeTimers();
    const fetchToken = vi.fn(() =>
      Promise.resolve<IssuedRealtimeToken>({ token: "t", expiresAt: 1 })
    );
    const view = render(
      <DocSyncConfigContext.Provider value={makeConfig("user-1", fetchToken)}>
        <DocSyncRoom roomId={ROOM_ID}>{null}</DocSyncRoom>
      </DocSyncConfigContext.Provider>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchToken).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});

describe("useIsOnDocSync", () => {
  it("is true under a connecting DocSyncRoom and false outside one", () => {
    const answers: boolean[] = [];
    function Probe() {
      answers.push(useIsOnDocSync());
      return null;
    }
    const config = makeConfig("user-1", () => new Promise(() => undefined));
    const view = render(
      <>
        <Probe />
        <DocSyncConfigContext.Provider value={config}>
          <DocSyncRoom roomId={ROOM_ID}>
            <Probe />
          </DocSyncRoom>
        </DocSyncConfigContext.Provider>
      </>
    );
    expect(answers).toEqual([false, true]);
    view.unmount();
  });
});

async function startServer(): Promise<string> {
  server = new Server({
    port: 0,
    quiet: true,
    onAuthenticate: ({ token }) =>
      token.startsWith("token-")
        ? Promise.resolve()
        : Promise.reject(new Error("bad token")),
  });
  await server.listen();
  return `ws://127.0.0.1:${server.address.port}`;
}

/** The shape `@repo/app`'s `ApiError` gives a failed request: `status` 0 when no response arrived. */
function answeredFailure(status: number): Error {
  return Object.assign(new Error(`status ${status}`), { status });
}

function renderFirstMint(fetchToken: DocSyncConfig["fetchToken"]) {
  let state: DocSyncRoomState | undefined;
  function Probe() {
    state = useDocSyncRoom();
    return null;
  }
  const view = render(
    <DocSyncConfigContext.Provider value={makeConfig("user-1", fetchToken)}>
      <DocSyncRoom roomId={ROOM_ID}>
        <Probe />
      </DocSyncRoom>
    </DocSyncConfigContext.Provider>
  );
  return { state: () => state, unmount: () => view.unmount() };
}

function makeConfig(
  userId: string,
  fetchToken: DocSyncConfig["fetchToken"]
): DocSyncConfig {
  return {
    fetchToken,
    self: { id: userId, color: "var(--color-red-500)" },
    resolveUser: (id) => ({ name: `Name of ${id}` }),
    mentionCandidates: [],
    maxMentionSuggestions: 6,
    renderMentionSuggestions: () => null,
  };
}

function mountRoom({
  url,
  userId,
  readOnly = false,
  firstOpenSeed,
}: {
  url: string;
  userId: string;
  readOnly?: boolean;
  firstOpenSeed?: DocSyncFirstOpenSeed;
}) {
  let minted = 0;
  const fetchToken = vi.fn((_room: string) => {
    minted += 1;
    return Promise.resolve<DocSyncTokenResponse>({
      token: `token-${minted}`,
      expiresAt: Date.now() + 60_000,
      url,
      ...(firstOpenSeed === undefined ? {} : { firstOpenSeed }),
    });
  });
  const probe = {
    mounts: 0,
    room: undefined as DocSyncRoomState | undefined,
    isSynced: false,
    everSynced: false,
    peers: { others: [], self: null } as DocSyncPeers,
  };
  function Probe() {
    probe.room = useDocSyncRoom();
    probe.isSynced = useDocSyncIsSynced();
    probe.everSynced ||= probe.isSynced;
    probe.peers = useDocSyncPeers();
    useEffect(() => {
      probe.mounts += 1;
    }, []);
    return null;
  }
  const view = render(
    <DocSyncConfigContext.Provider value={makeConfig(userId, fetchToken)}>
      <DocSyncRoom readOnly={readOnly} roomId={ROOM_ID}>
        <Probe />
      </DocSyncRoom>
    </DocSyncConfigContext.Provider>
  );
  const handle = () => {
    const room = probe.room?.room;
    if (!room) {
      throw new Error("room not open");
    }
    return room;
  };
  return {
    fetchToken,
    get mounts() {
      return probe.mounts;
    },
    synced: () => probe.isSynced,
    everSynced: () => probe.everSynced,
    failed: () => probe.room?.failed ?? false,
    peers: () => probe.peers,
    handle,
    ydoc: () => handle().ydoc,
    unmount: () => view.unmount(),
  };
}
