import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerListDocumentVersions } from "../tools/list-document-versions.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}>;

function createToolHarness(apiClient: ApiClient): ToolHandler {
  let handler: ToolHandler | undefined;
  const registerTool = vi.fn(
    (_name: string, _config: unknown, callback: ToolHandler): void => {
      handler = callback;
    }
  );

  registerListDocumentVersions({ registerTool } as never, apiClient);

  if (!handler) {
    throw new Error("Tool handler was not registered");
  }

  return handler;
}

function parseToolPayload(result: Awaited<ReturnType<ToolHandler>>) {
  if (result.isError) {
    throw new Error(result.content[0]?.text ?? "Tool returned an error");
  }
  return JSON.parse(result.content[0]?.text ?? "null");
}

describe("list-document-versions MCP tool", () => {
  it("paginates the unwrapped version array returned by ApiClient", async () => {
    const get = vi.fn().mockResolvedValue([
      {
        id: "version-2",
        version: 2,
        createdAt: "2026-05-14T04:11:39.337Z",
        createdById: "user-1",
      },
      {
        id: "version-1",
        version: 1,
        createdAt: "2026-05-13T16:31:44.128Z",
        createdById: "user-1",
      },
    ]);
    const handler = createToolHarness({ get } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ documentId: "PLN-15", limit: 1, offset: 0 })
    );

    expect(get).toHaveBeenCalledWith("/documents/PLN-15/versions");
    expect(payload).toEqual({
      total: 2,
      offset: 0,
      limit: 1,
      returned: 1,
      hasMore: true,
      nextOffset: 1,
      items: [
        {
          id: "version-2",
          version: 2,
          createdAt: "2026-05-14T04:11:39.337Z",
          createdById: "user-1",
          contentLength: null,
        },
      ],
    });
  });
});
