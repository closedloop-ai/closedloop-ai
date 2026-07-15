import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerSearch } from "../tools/search.js";

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

  registerSearch({ registerTool } as never, apiClient);

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

describe("search MCP tool", () => {
  it("forwards q to GET /search and shapes documents + projects", async () => {
    const get = vi.fn().mockResolvedValue({
      query: "auth",
      documents: [
        {
          id: "doc-1",
          title: "Auth plan",
          slug: "PLN-4",
          type: "IMPLEMENTATION_PLAN",
          status: "IN_PROGRESS",
          priority: "HIGH",
          projectName: "Platform",
          assignee: {
            id: "user-1",
            email: "a@b.com",
            firstName: "Ada",
            lastName: "Lovelace",
            avatarUrl: null,
          },
          updatedAt: "2026-05-14T04:11:39.337Z",
        },
      ],
      projects: [
        {
          id: "proj-1",
          name: "Auth",
          slug: "PRO-2",
          status: "ACTIVE",
          priority: null,
          teamName: "Core",
          teamId: "team-1",
          assignee: null,
          updatedAt: "2026-05-13T16:31:44.128Z",
        },
      ],
    });
    const handler = createToolHarness({ get } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({ q: "auth" }));

    expect(get).toHaveBeenCalledWith("/search", { q: "auth" });
    expect(payload.query).toBe("auth");
    expect(payload.documentCount).toBe(1);
    expect(payload.projectCount).toBe(1);
    expect(payload.documents[0]).toMatchObject({
      id: "doc-1",
      title: "Auth plan",
      slug: "PLN-4",
      type: "IMPLEMENTATION_PLAN",
      status: "IN_PROGRESS",
      projectName: "Platform",
    });
    // webUrl is derived from slug + type via the shared document URL builder.
    expect(payload.documents[0].webUrl).toContain("PLN-4");
    expect(payload.documents[0].assignee).toMatchObject({ id: "user-1" });
    expect(payload.projects[0]).toMatchObject({
      id: "proj-1",
      name: "Auth",
      slug: "PRO-2",
      teamName: "Core",
      teamId: "team-1",
      assignee: null,
    });
  });

  it("tolerates a response with missing documents/projects arrays", async () => {
    const get = vi.fn().mockResolvedValue({ query: "nothing" });
    const handler = createToolHarness({ get } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({ q: "nothing" }));

    expect(payload).toEqual({
      query: "nothing",
      documentCount: 0,
      projectCount: 0,
      documents: [],
      projects: [],
    });
  });

  it("surfaces API errors as tool errors", async () => {
    const get = vi.fn().mockRejectedValue(new Error("boom"));
    const handler = createToolHarness({ get } as unknown as ApiClient);

    const result = await handler({ q: "auth" });

    expect(result.isError).toBe(true);
  });
});
