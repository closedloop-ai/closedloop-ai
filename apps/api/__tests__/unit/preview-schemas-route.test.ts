import { afterEach, describe, expect, it, vi } from "vitest";
import type * as RouteUtils from "@/lib/route-utils";

const { mockScheduleLogFlush, mockValidateGitHubOidcToken } = vi.hoisted(
  () => ({
    mockScheduleLogFlush: vi.fn(),
    mockValidateGitHubOidcToken: vi.fn(),
  })
);

vi.mock("@/lib/auth/github-oidc-auth", () => ({
  validateGitHubOidcToken: mockValidateGitHubOidcToken,
}));

vi.mock("@/lib/route-utils", async () => {
  const actual = await vi.importActual<typeof RouteUtils>("@/lib/route-utils");
  return {
    ...actual,
    scheduleLogFlush: mockScheduleLogFlush,
  };
});

vi.mock("@/app/preview-schemas/service", () => ({
  previewSchemaCleanupService: {
    dropSchemaForBranch: vi.fn(),
    runDailySweep: vi.fn(),
    runDryRun: vi.fn(),
  },
}));

import { POST } from "@/app/preview-schemas/route";

describe("preview schema cleanup route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("flushes logs before returning an OIDC auth error", async () => {
    mockValidateGitHubOidcToken.mockResolvedValue(
      new Response("Unauthorized", { status: 401 })
    );
    const request = new Request("https://api.closedloop.ai/preview-schemas", {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
    });

    const response = await POST(request as Parameters<typeof POST>[0]);

    expect(response.status).toBe(401);
    expect(mockScheduleLogFlush).toHaveBeenCalledOnce();
  });
});
