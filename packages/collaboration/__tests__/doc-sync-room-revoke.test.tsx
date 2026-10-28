// @vitest-environment jsdom

import { Server } from "@hocuspocus/server";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import type { IssuedRealtimeToken } from "@repo/realtime-contract/protocol";
import {
  createRevocations,
  type Revocations,
} from "@repo/realtime-contract/revocations";
import { render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import {
  type DocSyncConfig,
  DocSyncConfigContext,
} from "../client/doc-sync-config";
import {
  DocSyncRoom,
  type DocSyncRoomState,
  useDocSyncIsSynced,
  useDocSyncRoom,
} from "../client/doc-sync-room";

const ORG = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const SLUG = "PRD-1";
const ROOM_ID = generateDocumentRoomId(ORG, SLUG);
const CHANNEL = formatChannelAddress(ChannelKind.Document, ORG, [SLUG]);
const USER = "user-1";
/** Past the room's first 1 s re-authentication backoff. */
const WAIT = { timeout: 8000 };

let server: Server | undefined;

beforeEach(() => {
  vi.stubGlobal("WebSocket", NodeWebSocket);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.destroy();
  server = undefined;
});

describe("DocSyncRoom after an org revoke", () => {
  it("re-mints and reconnects a member who keeps access when the fresh token shares the revoke's second", async () => {
    const revocations = createRevocations();
    const url = await startRevokingServer(revocations);
    const revokedAt = Date.now();
    const revokedSecond = Math.floor(revokedAt / 1000);
    // The API's clock: the first token predates the revoke, the reconnect's
    // is minted in the revoke's own second, and the next one after it.
    const issuedAt = [revokedSecond - 5, revokedSecond, revokedSecond + 1];
    const fetchToken = vi.fn(() =>
      Promise.resolve<IssuedRealtimeToken>({
        token: tokenString(USER, issuedAt.shift() ?? revokedSecond + 1),
        expiresAt: Date.now() + 60_000,
        url,
      })
    );
    const room = mountRoom(fetchToken);
    await waitFor(() => expect(room.synced()).toBe(true), WAIT);
    const handle = room.handle();

    revokeOrg(revocations, revokedAt);

    await waitFor(() => expect(fetchToken).toHaveBeenCalledTimes(3), WAIT);
    await waitFor(() => expect(room.synced()).toBe(true), WAIT);
    room.handle().ydoc.getMap("probe").set("text", "after the revoke");
    await waitFor(
      () =>
        expect(
          server?.hocuspocus.documents.get(ROOM_ID)?.getMap("probe").get("text")
        ).toBe("after the revoke"),
      WAIT
    );
    expect(room.handle()).toBe(handle);
    expect(room.state()?.failed).toBe(false);
    expect(room.mounts).toBe(1);
    room.unmount();
  }, 20_000);
});

/**
 * A Hocuspocus server that refuses, `forbidden`, a token a revoke binds, and
 * closes a revoke's connections in-band and then their sockets, as doc-sync
 * does (`apps/doc-sync/src/commands/connection-control.ts`).
 */
async function startRevokingServer(revocations: Revocations): Promise<string> {
  server = new Server({
    port: 0,
    quiet: true,
    onAuthenticate: ({ token }) => {
      const claims = parseTokenString(token);
      return revocations.covers(claims, CHANNEL)
        ? Promise.reject(
            Object.assign(new Error(RealtimeErrorCode.Forbidden), {
              reason: RealtimeErrorCode.Forbidden,
            })
          )
        : Promise.resolve();
    },
  });
  await server.listen();
  return `ws://127.0.0.1:${server.address.port}`;
}

function revokeOrg(revocations: Revocations, at: number): void {
  revocations.record({ target: { orgId: ORG }, at });
  for (const connection of server?.hocuspocus.documents
    .get(ROOM_ID)
    ?.getConnections() ?? []) {
    const event = { code: 4403, reason: RealtimeErrorCode.Forbidden };
    connection.close(event);
    connection.webSocket.close(event.code, event.reason);
  }
}

function tokenString(sub: string, iat: number): string {
  return `${sub}.${iat}`;
}

function parseTokenString(token: string): { sub: string; iat: number } {
  const [sub = "", iat = ""] = token.split(".");
  return { sub, iat: Number(iat) };
}

function mountRoom(fetchToken: DocSyncConfig["fetchToken"]) {
  const probe = {
    mounts: 0,
    room: undefined as DocSyncRoomState | undefined,
    isSynced: false,
  };
  function Probe() {
    probe.room = useDocSyncRoom();
    probe.isSynced = useDocSyncIsSynced();
    useEffect(() => {
      probe.mounts += 1;
    }, []);
    return null;
  }
  const config: DocSyncConfig = {
    fetchToken,
    self: { id: USER, color: "var(--color-red-500)" },
    resolveUser: (id) => ({ name: `Name of ${id}` }),
    mentionCandidates: [],
    maxMentionSuggestions: 6,
    renderMentionSuggestions: () => null,
  };
  const view = render(
    <DocSyncConfigContext.Provider value={config}>
      <DocSyncRoom roomId={ROOM_ID}>
        <Probe />
      </DocSyncRoom>
    </DocSyncConfigContext.Provider>
  );
  return {
    get mounts() {
      return probe.mounts;
    },
    state: () => probe.room,
    synced: () => probe.isSynced,
    handle: () => {
      const room = probe.room?.room;
      if (!room) {
        throw new Error("room not open");
      }
      return room;
    },
    unmount: () => view.unmount(),
  };
}
