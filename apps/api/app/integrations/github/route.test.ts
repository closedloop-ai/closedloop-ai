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

import { DELETE } from "./route";

function deleteRequest() {
  return new NextRequest("https://api.example.test/integrations/github", {
    method: "DELETE",
  });
}

describe("DELETE /integrations/github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.disconnectInstallation.mockResolvedValue(undefined);
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
