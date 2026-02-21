import { beforeEach, describe, expect, it, vi } from "vitest";

const { withApiKeyAuthMock, withAuthMock } = vi.hoisted(() => ({
  withApiKeyAuthMock: vi.fn(
    () => async () => ({}) as unknown as Promise<never>
  ),
  withAuthMock: vi.fn(() => async () => ({}) as unknown as Promise<never>),
}));

vi.mock("@/lib/auth/with-api-key-auth", () => ({
  withApiKeyAuth: withApiKeyAuthMock,
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: withAuthMock,
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
  });
});
