import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { type Grant, GrantAccess } from "@repo/realtime-contract/grants";
import {
  type ErrorPayload,
  joinAckSchema,
  RealtimeEvent,
} from "@repo/realtime-contract/protocol";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIGNAL_MAX_CHANNELS_PER_CONNECTION } from "../classes/signal";
import {
  type EdgeHarness,
  emitWithAck,
  grantedTokenFor,
  nextEvent,
  ORG_A,
  ORG_B,
  startEdge,
  USER_A,
  USER_B,
  welcomedClient,
} from "./edge-harness";

const DOC_1 = `comments:${ORG_A}:doc-1`;
const DOC_2 = `comments:${ORG_A}:doc-2`;
/** A kind this service has never seen, and no code here names. */
const PROBE = `probe:${ORG_A}:x`;
const ORG_A_COMMENTS: Grant = {
  pattern: `comments:${ORG_A}:*`,
  access: GrantAccess.Read,
};

let edge: EdgeHarness;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  edge = await startEdge();
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
  await edge.close();
});

async function clientWith(org: string, sub: string, grants: Grant[]) {
  const { client } = await welcomedClient(
    edge.url,
    await grantedTokenFor(org, sub, grants),
    clients
  );
  return client;
}

async function join(client: ClientSocket, channel: string) {
  return joinAckSchema.parse(
    await emitWithAck(client, RealtimeEvent.Join, { channel })
  );
}

async function serverRooms(client: ClientSocket): Promise<Set<string>> {
  const [socket] = await edge.io.in(client.id ?? "").fetchSockets();
  return socket?.rooms ?? new Set();
}

describe("rt:join grant enforcement", () => {
  it("joins a granted channel as its room and acks the address as channelId", async () => {
    const client = await clientWith(ORG_A, USER_A, [ORG_A_COMMENTS]);

    expect(await join(client, DOC_1)).toEqual({ ok: true, channelId: DOC_1 });
    expect(await serverRooms(client)).toContain(DOC_1);
  });

  it("joins a kind the service has never seen when a grant covers it", async () => {
    const granted = await clientWith(ORG_A, USER_A, [
      { pattern: PROBE, access: GrantAccess.Read },
    ]);
    const ungranted = await clientWith(ORG_A, USER_B, [ORG_A_COMMENTS]);

    expect(await join(granted, PROBE)).toEqual({ ok: true, channelId: PROBE });
    expect(await join(ungranted, PROBE)).toEqual({
      ok: false,
      code: RealtimeErrorCode.Forbidden,
    });
    expect(ungranted.connected).toBe(true);
  });

  it("refuses a channel in another organization even under a grant naming it", async () => {
    const orgBChannel = `comments:${ORG_B}:doc-1`;
    const client = await clientWith(ORG_A, USER_A, [
      ORG_A_COMMENTS,
      { pattern: `comments:${ORG_B}:*`, access: GrantAccess.Read },
    ]);
    const orgBClient = await clientWith(ORG_B, USER_B, [
      { pattern: `comments:${ORG_B}:*`, access: GrantAccess.Read },
    ]);

    expect(await join(client, orgBChannel)).toEqual({
      ok: false,
      code: RealtimeErrorCode.Forbidden,
    });
    expect(await join(orgBClient, orgBChannel)).toEqual({
      ok: true,
      channelId: orgBChannel,
    });
    expect(await join(orgBClient, DOC_1)).toEqual({
      ok: false,
      code: RealtimeErrorCode.Forbidden,
    });
  });

  it.each([
    ["a malformed address", "not-an-address"],
    ["an uppercase org segment", `comments:${ORG_A.toUpperCase()}:doc-1`],
  ])(
    "answers %s with bad_scope and stays connected",
    async (_label, channel) => {
      const client = await clientWith(ORG_A, USER_A, [ORG_A_COMMENTS]);

      expect(await join(client, channel)).toEqual({
        ok: false,
        code: RealtimeErrorCode.BadScope,
      });
      expect(client.connected).toBe(true);
    }
  );

  it("checks the grant before the channel limit", async () => {
    const client = await clientWith(ORG_A, USER_A, [ORG_A_COMMENTS]);
    await fillChannels(client, SIGNAL_MAX_CHANNELS_PER_CONNECTION);

    expect(await join(client, PROBE)).toEqual({
      ok: false,
      code: RealtimeErrorCode.Forbidden,
    });
  });

  it("admits the 100th channel, refuses the 101st, and re-acks one already joined", async () => {
    const client = await clientWith(ORG_A, USER_A, [ORG_A_COMMENTS]);
    await fillChannels(client, SIGNAL_MAX_CHANNELS_PER_CONNECTION - 1);

    const hundredth = channelNumbered(SIGNAL_MAX_CHANNELS_PER_CONNECTION);
    expect(await join(client, hundredth)).toEqual({
      ok: true,
      channelId: hundredth,
    });
    expect(
      await join(
        client,
        channelNumbered(SIGNAL_MAX_CHANNELS_PER_CONNECTION + 1)
      )
    ).toEqual({ ok: false, code: RealtimeErrorCode.RateLimited });
    expect(await join(client, hundredth)).toEqual({
      ok: true,
      channelId: hundredth,
    });
  });

  it("leaves a joined channel", async () => {
    const client = await clientWith(ORG_A, USER_A, [ORG_A_COMMENTS]);
    await join(client, DOC_1);

    expect(
      await emitWithAck(client, RealtimeEvent.Leave, { channel: DOC_1 })
    ).toEqual({ ok: true });
    expect(await serverRooms(client)).not.toContain(DOC_1);
  });
});

describe("rt:refresh and joined channels", () => {
  it("keeps channels the new grants cover and leaves the rest with forbidden", async () => {
    const client = await clientWith(ORG_A, USER_A, [ORG_A_COMMENTS]);
    await join(client, DOC_1);
    await join(client, DOC_2);
    const narrowed = await grantedTokenFor(ORG_A, USER_A, [
      { pattern: DOC_1, access: GrantAccess.Read },
    ]);
    const revoked = nextEvent<ErrorPayload>(client, RealtimeEvent.Error);

    const ack = await emitWithAck(client, RealtimeEvent.Refresh, {
      token: narrowed,
    });

    expect(ack).toMatchObject({ ok: true });
    expect(await revoked).toEqual({
      channel: DOC_2,
      code: RealtimeErrorCode.Forbidden,
    });
    const rooms = await serverRooms(client);
    expect(rooms).toContain(DOC_1);
    expect(rooms).not.toContain(DOC_2);
    expect(client.connected).toBe(true);
  });

  it("keeps the old grants and channels when the refresh is refused", async () => {
    const client = await clientWith(ORG_A, USER_A, [ORG_A_COMMENTS]);
    await join(client, DOC_1);

    expect(
      await emitWithAck(client, RealtimeEvent.Refresh, {
        token: await grantedTokenFor(ORG_B, USER_A, []),
      })
    ).toEqual({ ok: false, code: RealtimeErrorCode.Forbidden });
    expect(await serverRooms(client)).toContain(DOC_1);
    expect(await join(client, DOC_2)).toEqual({ ok: true, channelId: DOC_2 });
  });
});

function channelNumbered(index: number): string {
  return `comments:${ORG_A}:doc-${index}`;
}

async function fillChannels(client: ClientSocket, count: number) {
  for (let index = 1; index <= count; index += 1) {
    const ack = await join(client, channelNumbered(index));
    if (!ack.ok) {
      throw new Error(`channel ${index} was refused ${ack.code}`);
    }
  }
}
