import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disconnectInstallation: vi.fn(),
  getIntegrationStatus: vi.fn(),
  user: { id: "user-1", organizationId: "org-1" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler({ user: mocks.user }, request),
}));

vi.mock("./service", () => ({
  githubService: {
    disconnectInstallation: mocks.disconnectInstallation,
    getIntegrationStatus: mocks.getIntegrationStatus,
  },
}));

import { DELETE, GET } from "./route";

function deleteRequest() {
  return new NextRequest("https://api.example.test/integrations/github", {
    method: "DELETE",
  });
}

function getRequest() {
  return new NextRequest("https://api.example.test/integrations/github");
}

describe("/integrations/github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.disconnectInstallation.mockResolvedValue(undefined);
    mocks.getIntegrationStatus.mockResolvedValue({ connected: false });
  });

  it("gets the current organization's GitHub status for the current user", async () => {
    const response = await GET(getRequest(), {
      params: Promise.resolve({}),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { connected: false },
    });
    expect(mocks.getIntegrationStatus).toHaveBeenCalledWith("org-1", "user-1");
  });

  it("disconnects the current organization's GitHub installation", async () => {
    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({}),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { disconnected: true },
    });
    expect(mocks.disconnectInstallation).toHaveBeenCalledWith("org-1");
  });
});
