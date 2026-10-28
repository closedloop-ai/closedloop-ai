import { waitUntil } from "@vercel/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubDirtyScopeService } from "@/app/integrations/github/dirty-scope-service";
import { scheduleGitHubDirtyScopeRecoveryDrain } from "../service/github-dirty-scope-drain";

const { capturedWork } = vi.hoisted(() => ({
  capturedWork: [] as Promise<unknown>[],
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    capturedWork.push(promise);
  }),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

vi.mock("@/app/integrations/github/dirty-scope-service", () => ({
  githubDirtyScopeService: {
    dispatchDue: vi.fn(),
  },
}));

describe("scheduleGitHubDirtyScopeRecoveryDrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWork.length = 0;
  });

  it("contains a dirty-scope dispatch rejection inside waitUntil", async () => {
    vi.mocked(githubDirtyScopeService.dispatchDue).mockRejectedValue(
      new Error("dirty-scope unavailable")
    );

    scheduleGitHubDirtyScopeRecoveryDrain({
      organizationId: "org-dirty",
      targetId: "target-dirty",
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(capturedWork).toHaveLength(1);
    await expect(capturedWork[0]).resolves.toBeUndefined();
    expect(githubDirtyScopeService.dispatchDue).toHaveBeenCalledWith({
      computeTargetId: "target-dirty",
      organizationId: "org-dirty",
    });
  });
});
