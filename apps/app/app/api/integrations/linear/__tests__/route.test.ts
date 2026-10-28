import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getErrorRedirectUrl,
  getLinearCallbackUrl,
  LINEAR_ERROR_CODES,
  LINEAR_OAUTH_STATE_COOKIE,
  LINEAR_OAUTH_URL,
  LINEAR_PKCE_VERIFIER_COOKIE,
} from "../linear-utils";

const APP_URL = "http://localhost:3000";
const CLIENT_ID = "linear-client-id";
const PKCE = { codeChallenge: "challenge-1", codeVerifier: "verifier-1" };

const { mockAuth, mockCookiesSet, mockGeneratePKCE } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCookiesSet: vi.fn(),
  mockGeneratePKCE: vi.fn(),
}));

let mockEnv: Record<string, string | undefined> = {};

vi.mock("@/env", () => ({
  get env() {
    return mockEnv;
  },
}));

vi.mock("@repo/auth/server", () => ({ auth: () => mockAuth() }));

vi.mock("@repo/lib/security/pkce", () => ({
  generatePKCE: mockGeneratePKCE,
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ set: mockCookiesSet }),
}));

const { GET } = await import("../route");

describe("GET /api/integrations/linear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockEnv = {
      LINEAR_CLIENT_ID: CLIENT_ID,
      NEXT_PUBLIC_APP_URL: APP_URL,
    };
    mockAuth.mockResolvedValue({ orgId: "org-1", userId: "user-1" });
    mockGeneratePKCE.mockResolvedValue(PKCE);
  });

  it("redirects an unauthenticated visitor without starting the flow", async () => {
    mockAuth.mockResolvedValue({ orgId: null, userId: null });

    const response = await GET();

    expect(response.headers.get("location")).toBe(
      getErrorRedirectUrl(LINEAR_ERROR_CODES.NOT_AUTHENTICATED)
    );
    expect(mockCookiesSet).not.toHaveBeenCalled();
    expect(mockGeneratePKCE).not.toHaveBeenCalled();
  });

  it("redirects when Linear is not configured", async () => {
    mockEnv.LINEAR_CLIENT_ID = undefined;

    const response = await GET();

    expect(response.headers.get("location")).toBe(
      getErrorRedirectUrl(LINEAR_ERROR_CODES.NOT_CONFIGURED)
    );
    expect(mockCookiesSet).not.toHaveBeenCalled();
    expect(mockGeneratePKCE).not.toHaveBeenCalled();
  });

  // Asserted as a whole object, not parameter by parameter: dropping the scope
  // or response_type breaks the grant, and each survives a spot check of the
  // parameters someone thought to name.
  it("sends the same state to Linear that it stores in the cookie", async () => {
    const response = await GET();

    const location = new URL(response.headers.get("location") ?? "");
    const storedState = cookieValue(LINEAR_OAUTH_STATE_COOKIE);
    expect(storedState).toEqual(expect.any(String));

    expect(`${location.origin}${location.pathname}`).toBe(LINEAR_OAUTH_URL);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: CLIENT_ID,
      code_challenge: PKCE.codeChallenge,
      code_challenge_method: "S256",
      prompt: "consent",
      redirect_uri: getLinearCallbackUrl(),
      response_type: "code",
      scope: "read,write,issues:create",
      state: storedState,
    });
  });

  it("stores the state and verifier as short-lived host-only cookies", async () => {
    await GET();

    const expectedOptions = {
      httpOnly: true,
      maxAge: 600,
      path: "/",
      sameSite: "lax",
      secure: false,
    };
    expect(mockCookiesSet).toHaveBeenCalledWith(
      LINEAR_OAUTH_STATE_COOKIE,
      expect.any(String),
      expectedOptions
    );
    expect(mockCookiesSet).toHaveBeenCalledWith(
      LINEAR_PKCE_VERIFIER_COOKIE,
      PKCE.codeVerifier,
      expectedOptions
    );
  });

  it("marks both cookies secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await GET();

    for (const call of mockCookiesSet.mock.calls) {
      expect(call[2]).toMatchObject({ secure: true });
    }
    expect(mockCookiesSet).toHaveBeenCalledTimes(2);
  });

  it("redirects without leaking the failure when PKCE generation throws", async () => {
    mockGeneratePKCE.mockRejectedValue(new Error("entropy source failed"));

    const response = await GET();

    expect(response.headers.get("location")).toBe(
      getErrorRedirectUrl(LINEAR_ERROR_CODES.OAUTH_FAILED)
    );
    expect(mockCookiesSet).not.toHaveBeenCalled();
  });
});

function cookieValue(name: string): unknown {
  return mockCookiesSet.mock.calls.find(([called]) => called === name)?.[1];
}
