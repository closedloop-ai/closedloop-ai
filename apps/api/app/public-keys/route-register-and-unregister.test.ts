/**
 * ISS-11280 branch coverage for POST/DELETE /public-keys.
 *
 * `route.test.ts` and `route-auth-boundary.test.ts` cover GET's target-query
 * parsing exhaustively but never touch POST or DELETE. This file covers:
 * POST's body-validation-vs-service-call fork, its three-way error-message
 * switch on a failed registration, and DELETE's fingerprint-shape guard.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: { user: { id: "user-1", organizationId: "org-1" } },
  registerUserPublicKey: vi.fn(),
  unregisterUserPublicKey: vi.fn(),
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("./service", () => ({
  publicKeysService: {
    registerUserPublicKey: mocks.registerUserPublicKey,
    unregisterUserPublicKey: mocks.unregisterUserPublicKey,
  },
}));

import { DELETE, POST } from "./route";

const VALID_FINGERPRINT = `cl:${"A".repeat(22)}`;
const VALID_PUBLIC_KEY_BASE64 = "QUJDREVGRw==";

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/public-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteRequest(fingerprint?: string): NextRequest {
  const url = new URL("http://localhost/public-keys");
  if (fingerprint !== undefined) {
    url.searchParams.set("fingerprint", fingerprint);
  }
  return new NextRequest(url, { method: "DELETE" });
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /public-keys", () => {
  it("returns the parse error for a malformed body", async () => {
    const response = await POST(
      postRequest({
        publicKeyBase64: "not base64!!",
        fingerprint: VALID_FINGERPRINT,
      }),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.registerUserPublicKey).not.toHaveBeenCalled();
  });

  it("registers the key and returns it on success", async () => {
    mocks.registerUserPublicKey.mockResolvedValue({
      ok: true,
      value: { fingerprint: VALID_FINGERPRINT },
    });

    const response = await POST(
      postRequest({
        publicKeyBase64: VALID_PUBLIC_KEY_BASE64,
        fingerprint: VALID_FINGERPRINT,
      }),
      routeContext()
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual({ fingerprint: VALID_FINGERPRINT });
    expect(mocks.registerUserPublicKey).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
      payload: {
        publicKeyBase64: VALID_PUBLIC_KEY_BASE64,
        fingerprint: VALID_FINGERPRINT,
      },
    });
  });

  it("maps fingerprint_mismatch to its specific message", async () => {
    mocks.registerUserPublicKey.mockResolvedValue({
      ok: false,
      error: "fingerprint_mismatch",
    });

    const response = await POST(
      postRequest({
        publicKeyBase64: VALID_PUBLIC_KEY_BASE64,
        fingerprint: VALID_FINGERPRINT,
      }),
      routeContext()
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Fingerprint does not match public key");
  });

  it("maps unsupported_public_key to its specific message", async () => {
    mocks.registerUserPublicKey.mockResolvedValue({
      ok: false,
      error: "unsupported_public_key",
    });

    const response = await POST(
      postRequest({
        publicKeyBase64: VALID_PUBLIC_KEY_BASE64,
        fingerprint: VALID_FINGERPRINT,
      }),
      routeContext()
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Public key must be a raw Ed25519 public key");
  });

  it("falls back to the generic malformed message for an unrecognized error", async () => {
    mocks.registerUserPublicKey.mockResolvedValue({
      ok: false,
      error: "malformed_public_key",
    });

    const response = await POST(
      postRequest({
        publicKeyBase64: VALID_PUBLIC_KEY_BASE64,
        fingerprint: VALID_FINGERPRINT,
      }),
      routeContext()
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Malformed public key");
  });

  it("maps an unexpected service failure to a 500", async () => {
    mocks.registerUserPublicKey.mockRejectedValue(new Error("db down"));

    const response = await POST(
      postRequest({
        publicKeyBase64: VALID_PUBLIC_KEY_BASE64,
        fingerprint: VALID_FINGERPRINT,
      }),
      routeContext()
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to register public key");
  });
});

describe("DELETE /public-keys", () => {
  it("returns 400 for a malformed fingerprint", async () => {
    const response = await DELETE(
      deleteRequest("not-a-fingerprint"),
      routeContext()
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Malformed public key fingerprint");
    expect(mocks.unregisterUserPublicKey).not.toHaveBeenCalled();
  });

  it("unregisters the key for a valid fingerprint", async () => {
    mocks.unregisterUserPublicKey.mockResolvedValue({ deleted: true });

    const response = await DELETE(
      deleteRequest(VALID_FINGERPRINT),
      routeContext()
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual({ deleted: true });
    expect(mocks.unregisterUserPublicKey).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
      fingerprint: VALID_FINGERPRINT,
    });
  });

  it("maps an unexpected service failure to a 500", async () => {
    mocks.unregisterUserPublicKey.mockRejectedValue(new Error("db down"));

    const response = await DELETE(
      deleteRequest(VALID_FINGERPRINT),
      routeContext()
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to unregister public key");
  });
});
