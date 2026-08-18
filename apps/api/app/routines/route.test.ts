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
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

import { GET } from "./route";

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:3002/routines");
}

const context = { params: Promise.resolve({}) };

describe("GET /routines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with the (empty) routines list — shipped directly, no flag gate", async () => {
    const response = await GET(makeRequest(), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ data: { routines: [] } });
  });
});
