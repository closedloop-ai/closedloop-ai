import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findByOrganization: vi.fn(),
  findByTeam: vi.fn(),
  getValuesForEntity: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler({ user: { id: "user-1", organizationId: "org-1" } }, request),
}));

vi.mock("./service", () => ({
  projectsService: {
    findByOrganization: mocks.findByOrganization,
    findByTeam: mocks.findByTeam,
  },
}));

vi.mock("../custom-fields/values-service", () => ({
  customFieldValuesService: {
    getValuesForEntity: mocks.getValuesForEntity,
  },
}));

import { GET } from "./route";

function routeContext() {
  return { params: Promise.resolve({}) };
}

describe("GET /projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByOrganization.mockResolvedValue([]);
    mocks.findByTeam.mockResolvedValue([]);
    mocks.getValuesForEntity.mockResolvedValue([]);
  });

  it("returns 200 for a valid request without query params", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/projects"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.findByOrganization).toHaveBeenCalledWith("org-1", {
      excludeStatus: ["ARCHIVED"],
    });
  });

  it("forwards valid query params to the service", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/projects?teamId=team-1&limit=25"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.findByTeam).toHaveBeenCalledWith("team-1", "org-1", {
      limit: 25,
      excludeStatus: ["ARCHIVED"],
    });
  });

  it("rejects unsupported query params instead of silently dropping them (ISS-4505)", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/projects?unknownFilter=value"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(mocks.findByOrganization).not.toHaveBeenCalled();
    expect(mocks.findByTeam).not.toHaveBeenCalled();
  });

  it("rejects unsupported query params even when mixed with valid ones", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost:3002/projects?teamId=team-1&bogus=should-fail"
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findByTeam).not.toHaveBeenCalled();
  });

  it("honors limit on the organization path, not only the team path (shafty023)", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/projects?limit=25"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.findByOrganization).toHaveBeenCalledWith("org-1", {
      limit: 25,
      excludeStatus: ["ARCHIVED"],
    });
  });

  it("rejects __proto__ query param instead of silently swallowing it (shafty023)", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/projects?__proto__=polluted"),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findByOrganization).not.toHaveBeenCalled();
  });
});
