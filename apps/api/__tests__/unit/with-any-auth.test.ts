import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withApiKeyAuthMock,
  withAuthMock,
  withDesktopSessionAuthMock,
  isDesktopSessionTokenMock,
} = vi.hoisted(() => ({
  withApiKeyAuthMock: vi.fn(
    () => async () => ({}) as unknown as Promise<never>
  ),
  withAuthMock: vi.fn(() => async () => ({}) as unknown as Promise<never>),
  withDesktopSessionAuthMock: vi.fn(
    () => async () => ({}) as unknown as Promise<never>
  ),
  isDesktopSessionTokenMock: vi.fn(() => false),
}));

vi.mock("@/lib/auth/with-api-key-auth", () => ({
  withApiKeyAuth: withApiKeyAuthMock,
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: withAuthMock,
}));

vi.mock("@/lib/auth/with-desktop-session-auth", () => ({
  withDesktopSessionAuth: withDesktopSessionAuthMock,
}));

vi.mock("@repo/auth/desktop-session-jwt", () => ({
  isDesktopSessionToken: isDesktopSessionTokenMock,
}));

import { withAnyAuth } from "@/lib/auth/with-any-auth";

function createRequest(method: string, authorization?: string) {
  const headerMap = new Map<string, string>();
  if (authorization) {
    headerMap.set("authorization", authorization);
  }

  return {
    method,
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
  };
}

describe("withAnyAuth", () => {
  beforeEach(() => {
    withApiKeyAuthMock.mockClear();
    withAuthMock.mockClear();
    withDesktopSessionAuthMock.mockClear();
    isDesktopSessionTokenMock.mockClear();
    isDesktopSessionTokenMock.mockReturnValue(false);
  });

  it("defaults api-key GET requests to required read scope", async () => {
    const wrapped = withAnyAuth(async () => ({}) as never);
    await wrapped(
      createRequest("GET", "Bearer sk_live_test") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(withApiKeyAuthMock).toHaveBeenCalledWith(expect.any(Function), {
      requiredScopes: ["read"],
    });
  });

  it("defaults api-key mutation requests to required write scope", async () => {
    const wrapped = withAnyAuth(async () => ({}) as never);
    await wrapped(
      createRequest("POST", "Bearer sk_live_test") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(withApiKeyAuthMock).toHaveBeenCalledWith(expect.any(Function), {
      requiredScopes: ["write"],
    });
  });

  it("defaults api-key DELETE requests to required delete scope", async () => {
    const wrapped = withAnyAuth(async () => ({}) as never);
    await wrapped(
      createRequest("DELETE", "Bearer sk_live_test") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(withApiKeyAuthMock).toHaveBeenCalledWith(expect.any(Function), {
      requiredScopes: ["delete"],
    });
  });

  it("preserves explicit scope requirements when provided", async () => {
    const wrapped = withAnyAuth(async () => ({}) as never, {
      requiredScopes: ["write"],
    });
    await wrapped(
      createRequest("GET", "Bearer sk_live_test") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(withApiKeyAuthMock).toHaveBeenCalledWith(expect.any(Function), {
      requiredScopes: ["write"],
    });
  });

  it("uses session auth path for non-api-key bearer tokens", async () => {
    const wrapped = withAnyAuth(async () => ({}) as never);
    await wrapped(
      createRequest("GET", "Bearer not-an-api-key") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(withAuthMock).toHaveBeenCalledOnce();
    expect(withApiKeyAuthMock).not.toHaveBeenCalled();
    expect(withDesktopSessionAuthMock).not.toHaveBeenCalled();
  });

  it("routes desktop-classified bearer tokens to desktop-session auth, not Clerk", async () => {
    isDesktopSessionTokenMock.mockReturnValue(true);
    const wrapped = withAnyAuth(async () => ({}) as never);
    await wrapped(
      createRequest("GET", "Bearer desktop-access-token") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(isDesktopSessionTokenMock).toHaveBeenCalledWith(
      "desktop-access-token"
    );
    expect(withDesktopSessionAuthMock).toHaveBeenCalledOnce();
    expect(withAuthMock).not.toHaveBeenCalled();
    expect(withApiKeyAuthMock).not.toHaveBeenCalled();
  });

  it("does not desktop-classify api-key tokens (sk_live_ short-circuits first)", async () => {
    const wrapped = withAnyAuth(async () => ({}) as never);
    await wrapped(
      createRequest("GET", "Bearer sk_live_test") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(withApiKeyAuthMock).toHaveBeenCalledOnce();
    expect(isDesktopSessionTokenMock).not.toHaveBeenCalled();
    expect(withDesktopSessionAuthMock).not.toHaveBeenCalled();
  });
});
