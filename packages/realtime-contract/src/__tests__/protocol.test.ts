import { describe, expect, it } from "vitest";
import { RealtimeErrorCode, toRealtimeErrorCode } from "../error-codes";
import {
  DocSyncFirstOpenSeed,
  docSyncTokenResponseSchema,
  drainPayloadSchema,
  errorPayloadSchema,
  handshakeAuthSchema,
  issuedRealtimeTokenSchema,
  joinAckSchema,
  joinPayloadSchema,
  leavePayloadSchema,
  PROTOCOL_VERSION,
  RealtimeEvent,
  realtimeServiceUrlSchema,
  refreshAckSchema,
  refreshPayloadSchema,
  resyncPayloadSchema,
  signalPayloadSchema,
  welcomePayloadSchema,
} from "../protocol";

const ORG = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const CHANNEL = `comments:${ORG}:artifact-1`;

describe("RealtimeEvent", () => {
  it("namespaces every event under rt: (protocol v1 names)", () => {
    expect(Object.values(RealtimeEvent)).toEqual([
      "rt:join",
      "rt:leave",
      "rt:refresh",
      "rt:signal",
      "rt:resync",
      "rt:drain",
      "rt:error",
      "rt:welcome",
    ]);
  });
});

describe("handshakeAuthSchema", () => {
  const valid = {
    token: "t",
    protocol: PROTOCOL_VERSION,
    clientVersion: "1.2.3",
  };

  it("accepts a v1 handshake and ignores additive fields", () => {
    expect(handshakeAuthSchema.safeParse({ ...valid, extra: 1 }).success).toBe(
      true
    );
  });

  it("rejects a missing protocol", () => {
    const { protocol: _omit, ...rest } = valid;
    expect(handshakeAuthSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an unknown protocol", () => {
    expect(
      handshakeAuthSchema.safeParse({
        ...valid,
        protocol: PROTOCOL_VERSION + 1,
      }).success
    ).toBe(false);
  });

  it("rejects a missing token or clientVersion", () => {
    expect(handshakeAuthSchema.safeParse({ ...valid, token: "" }).success).toBe(
      false
    );
    const { clientVersion: _omit, ...rest } = valid;
    expect(handshakeAuthSchema.safeParse(rest).success).toBe(false);
  });
});

describe("payload schemas", () => {
  const cases = [
    {
      name: "join",
      schema: joinPayloadSchema,
      valid: [{ channel: CHANNEL }],
      invalid: [{}, { channel: "" }, { channel: 7 }],
    },
    {
      name: "leave",
      schema: leavePayloadSchema,
      valid: [{ channel: CHANNEL }],
      invalid: [{}, { channel: "" }],
    },
    {
      name: "refresh",
      schema: refreshPayloadSchema,
      valid: [{ token: "t" }],
      invalid: [{}, { token: "" }],
    },
    {
      name: "signal",
      schema: signalPayloadSchema,
      valid: [
        {
          channel: CHANNEL,
          type: "thread.updated",
          data: { id: "a", rev: 2 },
        },
      ],
      invalid: [
        { channel: CHANNEL, type: "Thread", data: {} },
        { channel: CHANNEL, type: "thread.updated" },
        { type: "thread.updated", data: {} },
      ],
    },
    {
      name: "resync",
      schema: resyncPayloadSchema,
      valid: [{}, { channel: CHANNEL }],
      invalid: [{ channel: "" }, { channel: 1 }],
    },
    {
      name: "drain",
      schema: drainPayloadSchema,
      valid: [{ afterMs: 0 }, { afterMs: 5000 }],
      invalid: [{}, { afterMs: -1 }, { afterMs: 1.5 }],
    },
    {
      name: "error",
      schema: errorPayloadSchema,
      valid: [
        { code: RealtimeErrorCode.TokenExpired },
        { channel: CHANNEL, code: RealtimeErrorCode.Forbidden },
      ],
      invalid: [{}, { code: "" }, { channel: CHANNEL }],
    },
    {
      name: "welcome",
      schema: welcomePayloadSchema,
      valid: [{ connectionId: "c1", protocol: PROTOCOL_VERSION }],
      invalid: [
        { connectionId: "c1" },
        { protocol: PROTOCOL_VERSION },
        { connectionId: "c1", protocol: PROTOCOL_VERSION + 1 },
      ],
    },
  ] as const;

  for (const { name, schema, valid, invalid } of cases) {
    it(`${name} accepts valid input and rejects malformed input`, () => {
      for (const input of valid) {
        expect(schema.safeParse(input).success).toBe(true);
      }
      for (const input of invalid) {
        expect(schema.safeParse(input).success).toBe(false);
      }
    });
  }
});

describe("acknowledgement schemas", () => {
  it("join ack accepts success and failure and rejects malformed shapes", () => {
    expect(joinAckSchema.safeParse({ ok: true, channelId: "1" }).success).toBe(
      true
    );
    expect(
      joinAckSchema.safeParse({ ok: false, code: RealtimeErrorCode.Forbidden })
        .success
    ).toBe(true);
    expect(joinAckSchema.safeParse({ ok: true }).success).toBe(false);
    expect(joinAckSchema.safeParse({ ok: false }).success).toBe(false);
    expect(joinAckSchema.safeParse({ channelId: "1" }).success).toBe(false);
  });

  it("refresh ack accepts success and failure and rejects malformed shapes", () => {
    expect(
      refreshAckSchema.safeParse({ ok: true, expiresAt: 1_700_000_000_000 })
        .success
    ).toBe(true);
    expect(
      refreshAckSchema.safeParse({
        ok: false,
        code: RealtimeErrorCode.Unauthorized,
      }).success
    ).toBe(true);
    expect(refreshAckSchema.safeParse({ ok: true }).success).toBe(false);
    expect(
      refreshAckSchema.safeParse({ ok: true, expiresAt: "soon" }).success
    ).toBe(false);
  });

  it("reads an error code this build does not know as the generic internal code", () => {
    const parsed = joinAckSchema.parse({ ok: false, code: "from_the_future" });
    expect(parsed).toEqual({ ok: false, code: RealtimeErrorCode.Internal });
    expect(toRealtimeErrorCode(RealtimeErrorCode.BadScope)).toBe(
      RealtimeErrorCode.BadScope
    );
  });
});

describe("realtimeServiceUrlSchema", () => {
  it("reads a socket URL as its origin, dropping a path socket.io would take for a namespace", () => {
    expect(
      realtimeServiceUrlSchema.parse("wss://realtime.example.test/realtime")
    ).toBe("wss://realtime.example.test");
    expect(realtimeServiceUrlSchema.parse("ws://localhost:3040")).toBe(
      "ws://localhost:3040"
    );
  });

  it("rejects a URL that is not ws:// or wss://", () => {
    expect(
      realtimeServiceUrlSchema.safeParse("https://realtime.example.test")
        .success
    ).toBe(false);
  });
});

describe("issuedRealtimeTokenSchema (PLN-2162)", () => {
  it("reads a token with and without a url", () => {
    expect(
      issuedRealtimeTokenSchema.parse({
        token: "t",
        expiresAt: 1,
        url: "wss://realtime.example.test",
      })
    ).toEqual({ token: "t", expiresAt: 1, url: "wss://realtime.example.test" });
    expect(
      issuedRealtimeTokenSchema.parse({ token: "t", expiresAt: 1 })
    ).toEqual({ token: "t", expiresAt: 1 });
  });

  it("reads a url that is not a string as absent rather than failing the token", () => {
    expect(
      issuedRealtimeTokenSchema.parse({ token: "t", expiresAt: 1, url: 42 })
    ).toEqual({ token: "t", expiresAt: 1, url: undefined });
  });

  it("rejects a body with no token or no expiry", () => {
    expect(issuedRealtimeTokenSchema.safeParse({ expiresAt: 1 }).success).toBe(
      false
    );
    expect(issuedRealtimeTokenSchema.safeParse({ token: "t" }).success).toBe(
      false
    );
    expect(
      issuedRealtimeTokenSchema.safeParse({ token: "", expiresAt: 1 }).success
    ).toBe(false);
  });
});

describe("docSyncTokenResponseSchema (ISS-12508)", () => {
  it("keeps an unconfirmed first-open seed, and reads a body without one", () => {
    expect(
      docSyncTokenResponseSchema.parse({
        token: "t",
        expiresAt: 1,
        firstOpenSeed: DocSyncFirstOpenSeed.Unconfirmed,
      })
    ).toEqual({
      token: "t",
      expiresAt: 1,
      firstOpenSeed: DocSyncFirstOpenSeed.Unconfirmed,
    });
    expect(
      docSyncTokenResponseSchema.parse({ token: "t", expiresAt: 1 })
    ).toEqual({ token: "t", expiresAt: 1 });
  });

  it("reads a first-open seed value this build does not know as absent rather than failing the token", () => {
    expect(
      docSyncTokenResponseSchema.parse({
        token: "t",
        expiresAt: 1,
        firstOpenSeed: "added-later",
      })
    ).toEqual({ token: "t", expiresAt: 1, firstOpenSeed: undefined });
  });

  it("rejects a body with no token", () => {
    expect(
      docSyncTokenResponseSchema.safeParse({
        expiresAt: 1,
        firstOpenSeed: DocSyncFirstOpenSeed.Unconfirmed,
      }).success
    ).toBe(false);
  });
});
