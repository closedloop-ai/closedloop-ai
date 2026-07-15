import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  get: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, _context: unknown) =>
      handler({ user: mocks.user }, request),
}));

vi.mock("./service", () => ({
  desktopIdentityService: { get: mocks.get },
}));

import { GET } from "./route";

function request() {
  return new NextRequest("https://api.closedloop.ai/desktop/identity");
}

describe("GET /desktop/identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the caller's display identity, org-scoped to the session", async () => {
    mocks.get.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
      email: "kris@closedloop.ai",
      firstName: "Kris",
      lastName: "Wong",
      organizationName: "Acme Inc",
    });

    const response = await GET(request(), { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith("user-1", "org-1");
    expect(body.data).toEqual({
      userId: "user-1",
      organizationId: "org-1",
      email: "kris@closedloop.ai",
      firstName: "Kris",
      lastName: "Wong",
      organizationName: "Acme Inc",
    });
  });

  it("404s when the user cannot be resolved", async () => {
    mocks.get.mockResolvedValue(null);

    const response = await GET(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(404);
  });

  it("500s when the service throws", async () => {
    mocks.get.mockRejectedValue(new Error("db down"));

    const response = await GET(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(500);
  });
});
