import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  clerkUserId: "clerk-user-1" as string | null,
  get: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, _context: unknown) =>
      handler({ user: mocks.user, clerkUserId: mocks.clerkUserId }, request),
}));

vi.mock("./service", () => ({
  desktopFeatureFlagsService: { get: mocks.get },
}));

import { GET } from "./route";

function request() {
  return new NextRequest("https://api.closedloop.ai/desktop/feature-flags");
}

describe("GET /desktop/feature-flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clerkUserId = "clerk-user-1";
  });

  it("resolves the assignment for the AUTHENTICATED principal, both distinct ids", async () => {
    mocks.get.mockResolvedValue({
      userId: "user-1",
      resolved: true,
      flags: { "agents-nav": true },
    });

    const response = await GET(request(), { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    // The route must never let a caller name the subject: both ids come from
    // the verified session, so a token can only ever read its own rollout.
    expect(mocks.get).toHaveBeenCalledWith({
      userId: "user-1",
      clerkUserId: "clerk-user-1",
      organizationId: "org-1",
    });
    expect(body.data).toEqual({
      userId: "user-1",
      resolved: true,
      flags: { "agents-nav": true },
    });
  });

  it("forwards a null clerk id rather than substituting the internal user id", async () => {
    mocks.clerkUserId = null;
    mocks.get.mockResolvedValue({
      userId: "user-1",
      resolved: true,
      flags: {},
    });

    await GET(request(), { params: Promise.resolve({}) });

    expect(mocks.get).toHaveBeenCalledWith({
      userId: "user-1",
      clerkUserId: null,
      organizationId: "org-1",
    });
  });

  it("surfaces UNAVAILABLE as resolved:false rather than an assignment of all-off", async () => {
    mocks.get.mockResolvedValue({
      userId: "user-1",
      resolved: false,
      flags: {},
    });

    const response = await GET(request(), { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.resolved).toBe(false);
    expect(body.data.flags).toEqual({});
  });

  it("500s rather than emitting a partial assignment when evaluation throws", async () => {
    mocks.get.mockRejectedValue(new Error("posthog exploded"));

    const response = await GET(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(500);
  });
});
