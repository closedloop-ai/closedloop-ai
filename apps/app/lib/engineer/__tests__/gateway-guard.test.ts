// @vitest-environment node
import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-origin", () => ({
  resolveApiOrigin: () => "http://api.test",
}));

import { gatewayGuard } from "@/lib/engineer/gateway-guard";

/**
 * Minimal NextRequest stand-in. gatewayGuard only reads `nextUrl.pathname` and
 * the `host` header; fetchHasComputeTarget reaches the (mocked) compute-targets
 * endpoint via the (mocked) resolveApiOrigin + global fetch. Using a literal
 * avoids undici's forbidden-header handling for `host`.
 */
function makeRequest(pathname: string, host: string): NextRequest {
  return {
    nextUrl: { pathname },
    headers: {
      get: (key: string) => (key.toLowerCase() === "host" ? host : null),
    },
  } as unknown as NextRequest;
}

function authReturning(state: {
  userId: string | null;
  token?: string | null;
}): { auth: ClerkMiddlewareAuth; calls: () => number } {
  const fn = vi.fn(() =>
    Promise.resolve({
      userId: state.userId,
      getToken: () => Promise.resolve(state.token ?? null),
    })
  );
  return {
    auth: fn as unknown as ClerkMiddlewareAuth,
    calls: () => fn.mock.calls.length,
  };
}

describe("gatewayGuard — AC-004.4 localhost-only enforcement", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("passes through non-gateway paths without consulting auth", async () => {
    const { auth, calls } = authReturning({ userId: "user-1" });
    const result = await gatewayGuard(
      auth,
      makeRequest("/dashboard", "app.example.com")
    );
    expect(result).toBeNull();
    expect(calls()).toBe(0);
  });

  it("allows /api/gateway/* from localhost", async () => {
    const { auth } = authReturning({ userId: "user-1" });
    const result = await gatewayGuard(
      auth,
      makeRequest("/api/gateway/git", "localhost:3000")
    );
    expect(result).toBeNull();
  });

  it("allows /api/gateway/* from 127.0.0.1", async () => {
    const { auth } = authReturning({ userId: "user-1" });
    const result = await gatewayGuard(
      auth,
      makeRequest("/api/gateway/git", "127.0.0.1:3000")
    );
    expect(result).toBeNull();
  });

  it("BLOCKS /api/gateway/* from a non-localhost host with 403 (no auth, no compute-target escape hatch)", async () => {
    const { auth, calls } = authReturning({
      userId: "user-1",
      token: "tok",
    });
    const result = await gatewayGuard(
      auth,
      makeRequest("/api/gateway/git", "evil.example.com")
    );
    expect(result?.status).toBe(403);
    await expect(result?.json()).resolves.toEqual({
      error: "Gateway API is only available on localhost",
    });
    // The local guard short-circuits before auth — being signed in with a
    // compute target must NOT unlock localhost-only command execution.
    expect(calls()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 401 for non-local /api/gateway-relay/* when unauthenticated", async () => {
    const { auth } = authReturning({ userId: null });
    const result = await gatewayGuard(
      auth,
      makeRequest("/api/gateway-relay/git", "app.example.com")
    );
    expect(result?.status).toBe(401);
    await expect(result?.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 403 for non-local /api/gateway-relay/* when the user has no compute target", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })
    );
    const { auth } = authReturning({ userId: "user-1", token: "tok" });
    const result = await gatewayGuard(
      auth,
      makeRequest("/api/gateway-relay/git", "app.example.com")
    );
    expect(result?.status).toBe(403);
    await expect(result?.json()).resolves.toEqual({
      error: "Gateway API requires a registered compute target",
    });
  });

  it("allows non-local /api/gateway-relay/* when the user has a registered compute target", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, data: [{ id: "target-1" }] }),
        { status: 200 }
      )
    );
    const { auth } = authReturning({ userId: "user-1", token: "tok" });
    const result = await gatewayGuard(
      auth,
      makeRequest("/api/gateway-relay/git", "app.example.com")
    );
    expect(result).toBeNull();
  });
});
