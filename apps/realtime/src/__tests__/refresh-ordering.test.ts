import { RealtimeEvent } from "@repo/realtime-contract/protocol";
import { createRevocations } from "@repo/realtime-contract/revocations";
import {
  REALTIME_TOKEN_AUDIENCE,
  REALTIME_TOKEN_ISSUER,
  type RealtimeTokenClaims,
} from "@repo/realtime-contract/token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHandlers } from "../edge/handlers";
import type { RealtimeSocket } from "../edge/socket-server";
import { type ConnectionState, clearTokenExpiry } from "../edge/token-expiry";
import { ORG_A, TEST_PUBLIC_KEYS, USER_A } from "./edge-harness";

const gates = new Map<string, Gate>();

vi.mock("@repo/realtime-contract/token", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/realtime-contract/token")>();
  return {
    ...actual,
    verifyRealtimeToken: (token: string) => gateFor(token).promise,
  };
});

const state: ConnectionState = { expiryTimer: undefined };

afterEach(() => {
  clearTokenExpiry(state);
  gates.clear();
});

describe("rt:refresh ordering", () => {
  it("keeps the later refresh's claims when the earlier one verifies last", async () => {
    const socket = fakeSocket(claimsWith("connect"));
    registerHandlers(socket.socket, state, {
      tokenKeys: { publicKeys: TEST_PUBLIC_KEYS },
      now: Date.now,
      revocations: createRevocations(),
    });
    const acks: unknown[] = [];

    socket.emit(RealtimeEvent.Refresh, { token: "first" }, (ack: unknown) =>
      acks.push(ack)
    );
    socket.emit(RealtimeEvent.Refresh, { token: "second" }, (ack: unknown) =>
      acks.push(ack)
    );
    gateFor("second").resolve(claimsWith("second"));
    await flushMicrotasks();
    gateFor("first").resolve(claimsWith("first"));
    await vi.waitFor(() => expect(acks).toHaveLength(2));

    expect(socket.socket.data.claims.jti).toBe("second");
  });
});

type Gate = {
  promise: Promise<RealtimeTokenClaims>;
  resolve: (claims: RealtimeTokenClaims) => void;
};

function gateFor(token: string): Gate {
  const existing = gates.get(token);
  if (existing) {
    return existing;
  }
  const { promise, resolve } = Promise.withResolvers<RealtimeTokenClaims>();
  const gate = { promise, resolve };
  gates.set(token, gate);
  return gate;
}

function claimsWith(jti: string): RealtimeTokenClaims {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub: USER_A,
    org: ORG_A,
    grants: [],
    jti,
    iat: nowSeconds,
    exp: nowSeconds + 600,
    aud: REALTIME_TOKEN_AUDIENCE,
    iss: REALTIME_TOKEN_ISSUER,
  };
}

type Listener = (...args: unknown[]) => void;

function fakeSocket(claims: RealtimeTokenClaims) {
  const listeners = new Map<string, Listener>();
  const socket = {
    id: "socket-1",
    connected: true,
    rooms: new Set(["socket-1"]),
    data: { claims, clientVersion: "test/1.0.0" },
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
    },
    emit: () => true,
    disconnect: () => undefined,
  };
  return {
    socket: socket as unknown as RealtimeSocket,
    emit: (event: string, ...args: unknown[]) =>
      listeners.get(event)?.(...args),
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}
