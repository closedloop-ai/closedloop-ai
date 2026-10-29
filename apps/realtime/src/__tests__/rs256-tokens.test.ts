import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { RealtimeEvent } from "@repo/realtime-contract/protocol";
import {
  REALTIME_TOKEN_AUDIENCE,
  REALTIME_TOKEN_ISSUER,
} from "@repo/realtime-contract/token";
import { SignJWT } from "jose";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectError,
  type EdgeHarness,
  emitWithAck,
  kidTokenFor,
  ORG_A,
  openClient,
  startComposedEdge,
  tokenFor,
  USER_A,
  validAuth,
  welcomedClient,
} from "./edge-harness";

const UNKNOWN_KID = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
/** The shape of the retired REALTIME_TOKEN_SECRETS value. */
const SHARED_SECRET = "realtime-test-secret-0123456789-abcdefgh";

let edge: EdgeHarness;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  edge = await startComposedEdge();
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
  await edge.close();
});

describe("RS256 grant tokens through the composed service (ISS-11966)", () => {
  it("admits a handshake whose token a configured kid signed", async () => {
    const { welcome } = await welcomedClient(
      edge.url,
      await tokenFor(ORG_A, USER_A),
      clients
    );

    expect(welcome.connectionId).toEqual(expect.any(String));
  });

  it("refuses a handshake whose kid has no configured key", async () => {
    const client = openClient(
      edge.url,
      validAuth(await kidTokenFor(ORG_A, USER_A, UNKNOWN_KID))
    );
    clients.push(client);

    expect(await connectError(client)).toEqual({
      code: RealtimeErrorCode.Unauthorized,
    });
  });
});

describe("an HS256 token signed with the retired shared secret (ISS-11966)", () => {
  it("is refused at the handshake", async () => {
    const client = openClient(edge.url, validAuth(await hs256TokenFor()));
    clients.push(client);

    expect(await connectError(client)).toEqual({
      code: RealtimeErrorCode.Unauthorized,
    });
  });

  it("is refused as a refresh on a connection an RS256 token opened", async () => {
    const { client } = await welcomedClient(
      edge.url,
      await tokenFor(ORG_A, USER_A),
      clients
    );

    expect(
      await emitWithAck(client, RealtimeEvent.Refresh, {
        token: await hs256TokenFor(),
      })
    ).toEqual({ ok: false, code: RealtimeErrorCode.Unauthorized });
  });
});

/** Claims apps/api minted before ISS-11966, signed as it signed them then. */
function hs256TokenFor(): Promise<string> {
  return new SignJWT({ org: ORG_A, grants: [] })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(USER_A)
    .setAudience(REALTIME_TOKEN_AUDIENCE)
    .setIssuer(REALTIME_TOKEN_ISSUER)
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti("jti-hs256")
    .sign(new TextEncoder().encode(SHARED_SECRET));
}
