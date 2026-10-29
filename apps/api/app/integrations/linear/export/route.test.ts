/**
 * ISS-6774: the export route awaits an Anthropic task extraction, and the
 * service reports a failed or timed-out extraction as `status: 500`. The route
 * switch handled only 404 and 502, so that server-side failure fell through to
 * `default` and reached the caller as HTTP 400 Bad Request — telling them to
 * fix a request that was fine. This pins each service status to the HTTP status
 * the route returns for it.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  exportImplementationPlan: vi.fn(),
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler({ user: mocks.user }, request),
}));

/** The route's typed signature takes the App Router context as a second arg. */
const routeContext = { params: Promise.resolve({}) };

vi.mock("../service", () => ({
  linearService: { exportImplementationPlan: mocks.exportImplementationPlan },
}));

import { POST } from "./route";

function request() {
  return new NextRequest(
    "https://api.example.test/integrations/linear/export",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: "11111111-1111-4111-8111-111111111111",
        teamId: "team-1",
      }),
    }
  );
}

describe("POST /integrations/linear/export status mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a failed task extraction as a server error, not a bad request", async () => {
    mocks.exportImplementationPlan.mockResolvedValue({
      success: false,
      error: "Failed to extract tasks from implementation plan",
      status: 500,
    });

    const response = await POST(request(), routeContext);

    expect(response.status).toBe(500);
  });

  it("reports a missing artifact as 404", async () => {
    mocks.exportImplementationPlan.mockResolvedValue({
      success: false,
      error: "Artifact not found",
      status: 404,
    });

    const response = await POST(request(), routeContext);

    expect(response.status).toBe(404);
  });

  it("reports an upstream Linear failure as 502", async () => {
    mocks.exportImplementationPlan.mockResolvedValue({
      success: false,
      error: "Linear token expired. Please reconnect Linear.",
      status: 502,
    });

    const response = await POST(request(), routeContext);
    const body = await response.json();

    expect(response.status).toBe(502);
    // The service's message is the actionable half ("reconnect Linear"); the
    // route used to overwrite it with a fixed "Linear API error".
    expect(body.error).toBe("Linear token expired. Please reconnect Linear.");
  });

  it("reports an unknown team as 403 and says which answer it is", async () => {
    mocks.exportImplementationPlan.mockResolvedValue({
      success: false,
      error: "Team not found in your Linear workspace",
      status: 403,
    });

    const response = await POST(request(), routeContext);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe("Team not found in your Linear workspace");
  });

  it("still reports caller misuse as 400", async () => {
    mocks.exportImplementationPlan.mockResolvedValue({
      success: false,
      error: "Only approved implementation plans can be exported to Linear",
      status: 400,
    });

    const response = await POST(request(), routeContext);

    expect(response.status).toBe(400);
  });
});
