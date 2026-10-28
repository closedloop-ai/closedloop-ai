import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  withAnyAuthOptions: [] as unknown[],
  resolveServedBranchStatusOrderingName: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>, options: unknown) =>
    (request: NextRequest) => {
      mocks.withAnyAuthOptions.push(options);
      return handler(mocks.auth, request);
    },
}));

vi.mock("../branch-status-ordering", () => ({
  resolveServedBranchStatusOrderingName:
    mocks.resolveServedBranchStatusOrderingName,
}));

import { GET } from "./route";

const REQUEST_URL = "https://api.example.test/branches/list-status-ordering";

describe("GET /branches/list-status-ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
  });

  it("requires read scope and states the served ordering", async () => {
    mocks.resolveServedBranchStatusOrderingName.mockResolvedValue("root_first");

    const response = await GET(new NextRequest(REQUEST_URL), {
      params: Promise.resolve({}),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(body.data).toEqual({ statusOrdering: "root_first" });
  });

  it("omits the ordering entirely when the producer cannot state one", async () => {
    mocks.resolveServedBranchStatusOrderingName.mockResolvedValue(undefined);

    const response = await GET(new NextRequest(REQUEST_URL), {
      params: Promise.resolve({}),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({});
  });
});
