import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { RealtimeEvent } from "@repo/realtime-contract/protocol";
import {
  REALTIME_TOKEN_AUDIENCE,
  REALTIME_TOKEN_ISSUER,
  type RealtimeTokenClaims,
} from "@repo/realtime-contract/token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeSocket } from "../edge/socket-server";
import {
  armTokenExpiry,
  type ConnectionState,
  clearTokenExpiry,
} from "../edge/token-expiry";

const NOW_MS = Date.UTC(2026, 8, 29, 12, 0, 0);

function claimsExpiringIn(seconds: number): RealtimeTokenClaims {
  const nowSeconds = NOW_MS / 1000;
  return {
    sub: "user_a",
    org: "0190a2b4-0000-7000-8000-00000000000a",
    grants: [],
    exp: nowSeconds + seconds,
    iat: nowSeconds,
    jti: "jti",
    aud: REALTIME_TOKEN_AUDIENCE,
    iss: REALTIME_TOKEN_ISSUER,
  };
}

function fakeSocket(claims: RealtimeTokenClaims) {
  const socket = {
    connected: true,
    data: { claims, clientVersion: "t" },
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
  return { socket, asSocket: socket as unknown as RealtimeSocket };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("armTokenExpiry", () => {
  it("emits token_expired then disconnects once exp passes with no refresh", () => {
    const { socket, asSocket } = fakeSocket(claimsExpiringIn(600));
    const state: ConnectionState = { expiryTimer: undefined };

    armTokenExpiry(state, asSocket, Date.now);
    vi.advanceTimersByTime(599_999);
    expect(socket.emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(socket.emit).toHaveBeenCalledWith(RealtimeEvent.Error, {
      code: RealtimeErrorCode.TokenExpired,
    });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("re-arms against refreshed claims, so the old expiry never fires", () => {
    const { socket, asSocket } = fakeSocket(claimsExpiringIn(600));
    const state: ConnectionState = { expiryTimer: undefined };
    armTokenExpiry(state, asSocket, Date.now);

    socket.data.claims = claimsExpiringIn(1200);
    armTokenExpiry(state, asSocket, Date.now);
    vi.advanceTimersByTime(600_000);
    expect(socket.disconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(600_000);
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });

  it("arms nothing once cleared or disconnected", () => {
    const { socket, asSocket } = fakeSocket(claimsExpiringIn(1));
    const state: ConnectionState = { expiryTimer: undefined };
    armTokenExpiry(state, asSocket, Date.now);
    clearTokenExpiry(state);

    socket.connected = false;
    armTokenExpiry(state, asSocket, Date.now);
    vi.advanceTimersByTime(10_000);

    expect(state.expiryTimer).toBeUndefined();
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});
