import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    authMethod: "session",
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: {
      id: "user-1",
      clerkId: "clerk-user-1",
      organizationId: "org-1",
    },
  },
  logError: vi.fn(),
  organizationsService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<{ id: string }> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("./service", () => ({
  organizationsService: mocks.organizationsService,
}));

import { GET } from "./route";

const ORG_ID = "org-1";
const BASE_ORGANIZATION = {
  active: true,
  clerkId: "clerk-org-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  id: ORG_ID,
  name: "Acme",
  settings: {},
  slug: "acme",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function makeRequest() {
  return new NextRequest("http://localhost/organizations");
}

describe("GET /organizations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the caller's organization as a single-item list", async () => {
    mocks.organizationsService.findById.mockResolvedValue(BASE_ORGANIZATION);

    const response = await GET(makeRequest(), { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.organizationsService.findById).toHaveBeenCalledWith(ORG_ID);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(ORG_ID);
  });

  it("returns an empty list when the organization is missing", async () => {
    mocks.organizationsService.findById.mockResolvedValue(null);

    const response = await GET(makeRequest(), { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("returns an error response when the service throws", async () => {
    mocks.organizationsService.findById.mockRejectedValue(new Error("boom"));

    const response = await GET(makeRequest(), { params: Promise.resolve({}) });

    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});
