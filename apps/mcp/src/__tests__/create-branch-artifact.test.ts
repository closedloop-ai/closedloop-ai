import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tools/tool-utils.js", () => ({
  asRecord: (value: unknown) =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {},
  readString: (value: unknown) => (typeof value === "string" ? value : null),
  withErrorHandling: (fn: () => Promise<unknown>) => fn(),
}));

import { registerCreateBranchArtifact } from "../tools/create-branch-artifact.js";

const registerTool = vi.fn();
const apiClient = {
  post: vi.fn(),
};

function registeredHandler() {
  return registerTool.mock.calls[0]?.[2] as
    | ((input: Record<string, unknown>) => Promise<unknown>)
    | undefined;
}

describe("create_branch_artifact MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerCreateBranchArtifact({ registerTool } as never, apiClient as never);
  });

  it("registers the exact write tool name", () => {
    expect(registerTool).toHaveBeenCalledWith(
      "create_branch_artifact",
      expect.objectContaining({
        description: expect.stringContaining("Requires write scope"),
        inputSchema: expect.objectContaining({
          projectId: expect.anything(),
          branchName: expect.anything(),
        }),
      }),
      expect.any(Function)
    );
  });

  it("posts the branch artifact request to the branch-native API route", async () => {
    apiClient.post.mockResolvedValue({ id: "branch-artifact-1" });
    const handler = registeredHandler();
    expect(handler).toBeDefined();

    const response = await handler?.({
      projectId: "019e0805-c8c1-74b6-ba51-2a84a6dc840a",
      branchName: "fea-1116",
      defaultBranch: "main",
      baseBranch: "main",
      headSha: "abc123",
    });

    expect(apiClient.post).toHaveBeenCalledWith("/artifact-links/branches", {
      projectId: "019e0805-c8c1-74b6-ba51-2a84a6dc840a",
      branchName: "fea-1116",
      defaultBranch: "main",
      baseBranch: "main",
      headSha: "abc123",
    });
    expect(response).toMatchObject({
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: "branch-artifact-1" }, null, 2),
        },
      ],
    });
  });
});
