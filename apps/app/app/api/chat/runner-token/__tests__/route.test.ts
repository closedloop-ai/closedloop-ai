// @vitest-environment node

import type { User } from "@repo/api/src/types/user";
import { ApproverRole } from "@repo/api/src/types/user";
import {
  AUDIENCE,
  DEFAULT_TTL_SECONDS,
  verifyChatRunnerToken,
} from "@repo/auth/chat-runner-jwt";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockAuth = vi.fn();

vi.mock("@repo/auth/server", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_API_URL: "http://localhost:3002",
  },
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

// Secret must satisfy min length (32) and min unique characters (8).
process.env.CLOSEDLOOP_RUNNER_JWT_SECRET =
  "test-chat-runner-secret-abcdefghijklmnopqrstuvwxyz-0123456789";

const FAILURE_MESSAGE_REGEX = /resolve|mint/i;
// A whole second, so the token's floored `exp` claim and the response's
// unfloored `expiresAt` land on the same millisecond.
const PINNED_NOW_MS = Date.parse("2026-07-01T00:00:00.000Z");

const { POST } = await import("../route");

function createMockRequest(body: unknown): NextRequest {
  const request = new Request("http://localhost:3000/api/chat/runner-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Cast is safe: the route reads `request.nextUrl` for preview-host
  // rewriting and `.json()` for the body. NextRequest extends Request and
  // only adds readable getters.
  (request as unknown as { nextUrl: URL }).nextUrl = new URL(
    "http://localhost:3000/api/chat/runner-token"
  );
  return request as unknown as NextRequest;
}

function makeMockUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-uuid-1",
    clerkId: "clerk_user_1",
    organizationId: "org-uuid-1",
    email: "test@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    avatarUrl: null,
    phoneNumber: null,
    role: ApproverRole.Engineer,
    linearId: null,
    slackId: null,
    githubUsername: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mockMeSuccess(user: User): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValueOnce({ success: true, data: user }),
  });
}

describe("POST /api/chat/runner-token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("mints a token for a first-time user (find-or-create succeeds)", async () => {
    const user = makeMockUser({
      id: "user-uuid-first-time",
      organizationId: "org-uuid-first-time",
    });
    mockAuth.mockResolvedValueOnce({
      userId: "clerk_first_time",
      getToken: vi.fn().mockResolvedValueOnce("clerk-token"),
    });
    mockMeSuccess(user);

    // Only `Date` is faked: the route's TTL math becomes exact, while jose and
    // the mocked fetch keep real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW_MS);

    const response = await POST(createMockRequest({ chatKey: "chat-1" }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      apiBaseUrl: string;
      expiresAt: string;
    };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.apiBaseUrl).toBe("http://localhost:3002");
    // Exact, not "in the future" — and it must agree with the minted token's
    // own `exp` claim, which the route computes on a separate code path.
    expect(Date.parse(body.expiresAt)).toBe(
      PINNED_NOW_MS + DEFAULT_TTL_SECONDS * 1000
    );

    // /me was called once with the Clerk bearer token.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3002/me");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer clerk-token"
    );

    // Token is decodable and carries the right audience and claims.
    const claims = await verifyChatRunnerToken(body.token);
    expect(claims.audience).toBe(AUDIENCE);
    expect(claims.userId).toBe("user-uuid-first-time");
    expect(claims.organizationId).toBe("org-uuid-first-time");
    expect(claims.chatKey).toBe("chat-1");
    expect(claims.expiresAt * 1000).toBe(Date.parse(body.expiresAt));
  });

  test("mints a token for an existing user", async () => {
    const user = makeMockUser();
    mockAuth.mockResolvedValueOnce({
      userId: "clerk_user_1",
      getToken: vi.fn().mockResolvedValueOnce("clerk-token"),
    });
    mockMeSuccess(user);

    const response = await POST(
      createMockRequest({ chatKey: "chat-existing" })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      apiBaseUrl: string;
    };
    const claims = await verifyChatRunnerToken(body.token);
    expect(claims.userId).toBe("user-uuid-1");
    expect(claims.organizationId).toBe("org-uuid-1");
    expect(claims.chatKey).toBe("chat-existing");
  });

  test("returns 401 when there is no Clerk session", async () => {
    mockAuth.mockResolvedValueOnce({
      userId: null,
      getToken: vi.fn(),
    });

    const response = await POST(createMockRequest({ chatKey: "chat-1" }));

    expect(response.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns 400 when chatKey is missing", async () => {
    mockAuth.mockResolvedValueOnce({
      userId: "clerk_user_1",
      getToken: vi.fn().mockResolvedValueOnce("clerk-token"),
    });

    const response = await POST(createMockRequest({}));

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns 400 when chatKey is empty", async () => {
    mockAuth.mockResolvedValueOnce({
      userId: "clerk_user_1",
      getToken: vi.fn().mockResolvedValueOnce("clerk-token"),
    });

    const response = await POST(createMockRequest({ chatKey: "" }));

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns 500 (no lookup-only fallback) when /me fails with 5xx", async () => {
    mockAuth.mockResolvedValueOnce({
      userId: "clerk_user_1",
      getToken: vi.fn().mockResolvedValueOnce("clerk-token"),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValueOnce({
        success: false,
        error: "Internal server error",
      }),
    });

    const response = await POST(createMockRequest({ chatKey: "chat-1" }));

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(FAILURE_MESSAGE_REGEX);
    // Only the single /me attempt was made, no silent fallback.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("returns 500 when /me returns an error envelope", async () => {
    mockAuth.mockResolvedValueOnce({
      userId: "clerk_user_1",
      getToken: vi.fn().mockResolvedValueOnce("clerk-token"),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi
        .fn()
        .mockResolvedValueOnce({ success: false, error: "User not found" }),
    });

    const response = await POST(createMockRequest({ chatKey: "chat-1" }));

    expect(response.status).toBe(500);
  });

  test("returns 500 when the Clerk session token is unavailable", async () => {
    mockAuth.mockResolvedValueOnce({
      userId: "clerk_user_1",
      getToken: vi.fn().mockResolvedValueOnce(null),
    });

    const response = await POST(createMockRequest({ chatKey: "chat-1" }));

    expect(response.status).toBe(500);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns 500 when /me fetch throws a network error", async () => {
    mockAuth.mockResolvedValueOnce({
      userId: "clerk_user_1",
      getToken: vi.fn().mockResolvedValueOnce("clerk-token"),
    });
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const response = await POST(createMockRequest({ chatKey: "chat-1" }));

    expect(response.status).toBe(500);
  });
});
