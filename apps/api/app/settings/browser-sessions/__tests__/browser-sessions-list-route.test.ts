import {
  BROWSER_SESSION_OFFSET_MAX,
  BROWSER_SESSION_PAGE_LIMIT_DEFAULT,
  BROWSER_SESSION_PAGE_LIMIT_MAX,
  BrowserSessionErrorCode,
} from "@repo/api/src/types/browser-session";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    clerkSessionId: "sess_current" as string | undefined,
    authMethod: "session" as "session" | "api_key" | "desktop_session",
    user: { id: "user-1", organizationId: "org-1" },
  },
  listUserBrowserSessions: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    listUserBrowserSessions: mocks.listUserBrowserSessions,
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    flush: vi.fn(async () => undefined),
  },
}));

import { GET } from "../route";

function listRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/settings/browser-sessions${query}`);
}

function row(id: string, activity: unknown = null) {
  return {
    id,
    lastActiveAt: "2026-09-03T17:00:00.000Z",
    expireAt: "2026-09-10T17:00:00.000Z",
    activity,
  };
}

beforeEach(() => {
  mocks.listUserBrowserSessions.mockReset();
  mocks.listUserBrowserSessions.mockResolvedValue({
    sessions: [],
    totalCount: 0,
  });
  mocks.authContext.clerkSessionId = "sess_current";
  mocks.authContext.authMethod = "session";
});

describe("GET /settings/browser-sessions — page bounds", () => {
  // The provider answers an out-of-range limit with 200 and its own 10-row
  // default rather than an error, so these cases pin the clamp itself. Without
  // it the caller receives a short page that reads as the complete set.
  it.each([
    ["?limit=0", 1],
    ["?limit=-1", 1],
    [
      `?limit=${BROWSER_SESSION_PAGE_LIMIT_MAX + 1}`,
      BROWSER_SESSION_PAGE_LIMIT_MAX,
    ],
    ["?limit=1.9", 1],
    ["", BROWSER_SESSION_PAGE_LIMIT_DEFAULT],
  ])("clamps %s to a page size of %i", async (query, expected) => {
    const response = await GET(listRequest(query), {
      params: Promise.resolve({}),
    });
    const body = await response.json();

    expect(mocks.listUserBrowserSessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: expected })
    );
    // Echoed too, so the consumer sees the bound that was actually applied.
    expect(body.data.limit).toBe(expected);
  });

  it("hands the requesting browser's user agent to the session read", async () => {
    // ISS-12135: the local-trusted vibe session describes its own browser.
    const request = new NextRequest(
      "http://localhost/settings/browser-sessions",
      {
        headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/141.0.0.0" },
      }
    );
    await GET(request, { params: Promise.resolve({}) });

    expect(mocks.listUserBrowserSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/141.0.0.0",
      })
    );
  });

  it("floors a negative offset at zero", async () => {
    await GET(listRequest("?offset=-5"), { params: Promise.resolve({}) });

    expect(mocks.listUserBrowserSessions).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0 })
    );
  });

  it("caps an absurd offset instead of letting the provider reject it", async () => {
    const response = await GET(listRequest("?offset=99999999"), {
      params: Promise.resolve({}),
    });

    // Unclamped, the provider throws and the route reports 503
    // provider_unavailable plus an error log — a caller mistake dressed up as
    // an outage, on a path any authenticated caller can drive.
    expect(response.status).toBe(200);
    expect(mocks.listUserBrowserSessions).toHaveBeenCalledWith(
      expect.objectContaining({ offset: BROWSER_SESSION_OFFSET_MAX })
    );
  });

  it("reports the provider total, not the page length", async () => {
    mocks.listUserBrowserSessions.mockResolvedValue({
      sessions: [row("sess_a"), row("sess_b")],
      totalCount: 2436,
    });

    const response = await GET(listRequest("?limit=2"), {
      params: Promise.resolve({}),
    });
    const body = await response.json();

    // A truncated first page must not read as the complete set.
    expect(body.data.sessions).toHaveLength(2);
    expect(body.data.totalCount).toBe(2436);
  });
});

describe("GET /settings/browser-sessions — malformed query", () => {
  // Each of these used to reach the service as a silently substituted bound: a
  // present-but-blank value coerced to 0 and clamped to a one-row page, an
  // unknown key stripped so the default page answered a request the route never
  // honored. Both shapes return 200 with a bound the caller did not send, which
  // is the answer this block exists to prevent.
  it.each([
    ["a blank limit", "?limit="],
    ["a whitespace-only offset", "?offset=%20"],
    ["a misspelled page param", "?limt=20"],
    ["an unsupported filter this route cannot honor", "?limit=5&status=active"],
  ])("rejects %s", async (_label, query) => {
    const response = await GET(listRequest(query), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(400);
    expect(mocks.listUserBrowserSessions).not.toHaveBeenCalled();
  });

  it("still honors the two params it does implement", async () => {
    const response = await GET(listRequest("?limit=5&offset=10"), {
      params: Promise.resolve({}),
    });

    // The counterweight to the block above: a schema that rejects everything
    // would pass those cases and break the route.
    expect(response.status).toBe(200);
    expect(mocks.listUserBrowserSessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, offset: 10 })
    );
  });
});

describe("GET /settings/browser-sessions — current-session identity", () => {
  it("marks the caller's own row current on a Clerk session transport", async () => {
    mocks.listUserBrowserSessions.mockResolvedValue({
      sessions: [row("sess_current"), row("sess_other")],
      totalCount: 2,
    });

    const response = await GET(listRequest(), { params: Promise.resolve({}) });
    const body = await response.json();

    expect(body.data.currentSessionKnown).toBe(true);
    expect(body.data.sessions[0].isCurrentSession).toBe(true);
    expect(body.data.sessions[1].isCurrentSession).toBe(false);
  });

  it("reports no row current AND says so, on a Desktop transport", async () => {
    mocks.authContext.authMethod = "desktop_session";
    mocks.authContext.clerkSessionId = undefined;
    mocks.listUserBrowserSessions.mockResolvedValue({
      sessions: [row("sess_current"), row("sess_other")],
      totalCount: 2,
    });

    const response = await GET(listRequest(), { params: Promise.resolve({}) });
    const body = await response.json();

    // Both halves matter. Every row non-current is only honest alongside
    // currentSessionKnown:false — otherwise the panel would offer to sign the
    // user out of the session they are holding.
    expect(
      body.data.sessions.every(
        (s: { isCurrentSession: boolean }) => !s.isCurrentSession
      )
    ).toBe(true);
    expect(body.data.currentSessionKnown).toBe(false);
  });
});

describe("GET /settings/browser-sessions — transport and failure", () => {
  it("refuses a machine api-key credential", async () => {
    mocks.authContext.authMethod = "api_key";

    const response = await GET(listRequest(), { params: Promise.resolve({}) });

    expect(response.status).toBe(403);
    expect(mocks.listUserBrowserSessions).not.toHaveBeenCalled();
  });

  it("answers 503 when the provider read fails, never an empty list", async () => {
    mocks.listUserBrowserSessions.mockRejectedValue(new Error("clerk down"));

    const response = await GET(listRequest(), { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.metadata?.code ?? body.code).toBe(
      BrowserSessionErrorCode.ProviderUnavailable
    );
    expect(body.data).toBeUndefined();
  });
});
