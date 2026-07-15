import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { registerCreateDocumentThread } from "../tools/create-document-thread.js";

const registerTool = vi.fn();
const apiClient = {
  post: vi.fn(),
};

describe("create-document-thread MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerCreateDocumentThread({ registerTool } as never, apiClient as never);
  });

  it("includes anchorText in the POST body when provided", async () => {
    apiClient.post.mockResolvedValue({ id: "thread-1" });

    await registeredHandler()?.({
      documentId: "FEA-42",
      body: "Please review this passage",
      anchorText: "specific text to anchor",
    });

    expect(apiClient.post).toHaveBeenCalledWith("/documents/FEA-42/threads", {
      body: "Please review this passage",
      anchorText: "specific text to anchor",
    });
  });

  it("omits anchorText from the POST body when not provided", async () => {
    apiClient.post.mockResolvedValue({ id: "thread-1" });

    await registeredHandler()?.({
      documentId: "FEA-42",
      body: "Unanchored artifact-level note",
    });

    const calledBody = apiClient.post.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(calledBody).toEqual({ body: "Unanchored artifact-level note" });
    expect(calledBody).not.toHaveProperty("anchorText");
  });

  it("rejects an empty string for anchorText via schema validation", () => {
    const schema = registeredSchema();
    const anchorTextSchema = schema?.anchorText as z.ZodType | undefined;
    const result = anchorTextSchema?.safeParse("");
    expect(result?.success).toBe(false);
  });
});

function registeredHandler():
  | ((input: {
      documentId: string;
      body: string;
      anchorText?: string;
    }) => Promise<{ content?: { text?: string }[] }>)
  | undefined {
  return registerTool.mock.calls[0]?.[2];
}

function registeredSchema(): Record<string, z.ZodType> | undefined {
  return registerTool.mock.calls[0]?.[1]?.inputSchema;
}
