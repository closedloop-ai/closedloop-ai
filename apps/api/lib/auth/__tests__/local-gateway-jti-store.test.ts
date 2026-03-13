import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeJti,
  registerJti,
  resetLocalGatewayJtiStoreForTests,
} from "../local-gateway-jti-store";
import { LOCAL_GATEWAY_CHALLENGE_TTL_SECONDS } from "../local-gateway-jwt";

const JTI_TTL_MS = (LOCAL_GATEWAY_CHALLENGE_TTL_SECONDS + 10) * 1000;

describe("local-gateway-jti-store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T12:00:00.000Z"));
    resetLocalGatewayJtiStoreForTests();
  });

  afterEach(() => {
    resetLocalGatewayJtiStoreForTests();
    vi.useRealTimers();
  });

  it("consumes a registered jti only once", () => {
    registerJti("jti-123");

    expect(consumeJti("jti-123")).toBe(true);
    expect(consumeJti("jti-123")).toBe(false);
  });

  it("expires a registered jti after the store ttl elapses", () => {
    registerJti("jti-123");

    vi.advanceTimersByTime(JTI_TTL_MS + 1);

    expect(consumeJti("jti-123")).toBe(false);
  });
});
