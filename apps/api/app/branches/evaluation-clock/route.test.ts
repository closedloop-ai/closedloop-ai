import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", clerkId: "clerk-user-1", organizationId: "org-1" },
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

const REQUEST_URL = "https://api.example.test/branches/evaluation-clock";

describe("GET /branches/evaluation-clock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the legacy read-scope response shape for deployed clients", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T18:00:00.000Z"));
    mocks.resolveServedBranchStatusOrderingName.mockResolvedValue("root_first");

    const response = await GET(new NextRequest(REQUEST_URL), {
      params: Promise.resolve({}),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(body.data).toEqual({
      evaluationNow: "2026-08-22T18:00:00.000Z",
      statusOrdering: "root_first",
    });
  });
});
