import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMoveArtifact } from "../tools/move-artifact.js";

const UUID = "019e0805-c8c1-74b6-ba51-2a84a6dc840a";
const REF_UUID = "019e0805-c8c1-74b6-ba51-2a84a6dc8999";
const MISSING_REFERENCE_ERROR = /requires referenceArtifactId/;
const UNEXPECTED_REFERENCE_ERROR =
  /only valid with position 'before' or 'after'/;

const registerTool = vi.fn();
const apiClient = {
  get: vi.fn(),
  post: vi.fn(),
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};
type Handler = (input: Record<string, unknown>) => Promise<ToolResult>;

function registeredHandler(): Handler | undefined {
  return registerTool.mock.calls[0]?.[2] as Handler | undefined;
}

describe("move-artifact MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerMoveArtifact({ registerTool } as never, apiClient as never);
  });

  it("registers the exact write tool name and schema", () => {
    expect(registerTool).toHaveBeenCalledWith(
      "move-artifact",
      expect.objectContaining({
        description: expect.stringContaining("Requires write scope"),
        inputSchema: expect.objectContaining({
          projectId: expect.anything(),
          artifactId: expect.anything(),
          position: expect.anything(),
          referenceArtifactId: expect.anything(),
        }),
      }),
      expect.any(Function)
    );
  });

  it("posts a top move without resolving a UUID artifactId", async () => {
    apiClient.post.mockResolvedValue({ moved: true, newSortOrder: 0 });
    const response = await registeredHandler()?.({
      projectId: "PRO-7",
      artifactId: UUID,
      position: "top",
    });

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(apiClient.post).toHaveBeenCalledWith(
      "/projects/PRO-7/artifacts/move",
      { artifactId: UUID, position: "top" }
    );
    expect(response).toMatchObject({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              moved: true,
              artifactId: UUID,
              position: "top",
              referenceArtifactId: null,
              newSortOrder: 0,
            },
            null,
            2
          ),
        },
      ],
    });
  });

  it("passes a slug artifactId straight through (the move endpoint resolves it)", async () => {
    apiClient.post.mockResolvedValue({ moved: true, newSortOrder: 3000 });

    await registeredHandler()?.({
      projectId: "PRO-7",
      artifactId: "PLN-12",
      position: "bottom",
    });

    // No client-side resolution: the slug is forwarded as-is.
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(apiClient.post).toHaveBeenCalledWith(
      "/projects/PRO-7/artifacts/move",
      { artifactId: "PLN-12", position: "bottom" }
    );
  });

  it("forwards artifact and reference slugs unchanged for a before move", async () => {
    apiClient.post.mockResolvedValue({ moved: true, newSortOrder: 1500 });

    await registeredHandler()?.({
      projectId: "PRO-7",
      artifactId: "PLN-12",
      position: "before",
      referenceArtifactId: "FEA-42",
    });

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(apiClient.post).toHaveBeenCalledWith(
      "/projects/PRO-7/artifacts/move",
      {
        artifactId: "PLN-12",
        position: "before",
        referenceArtifactId: "FEA-42",
      }
    );
  });

  it("returns an isError response for a before/after move without a referenceArtifactId", async () => {
    const result = await registeredHandler()?.({
      projectId: "PRO-7",
      artifactId: UUID,
      position: "after",
    });

    expect(result).toMatchObject({ isError: true });
    expect(result?.content[0]?.text).toMatch(MISSING_REFERENCE_ERROR);
    // Pairing is validated before any resolution: no slug round-trip, no move.
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("returns an isError response for a top move that carries a referenceArtifactId", async () => {
    const result = await registeredHandler()?.({
      projectId: "PRO-7",
      artifactId: UUID,
      position: "top",
      referenceArtifactId: REF_UUID,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result?.content[0]?.text).toMatch(UNEXPECTED_REFERENCE_ERROR);
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
