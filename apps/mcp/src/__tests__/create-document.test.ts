import { Priority } from "@repo/api/src/types/common.js";
import { DocumentType, FeatureStatus } from "@repo/api/src/types/document.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { registerCreateDocument } from "../tools/create-document.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}>;

function createToolHarness(apiClient: ApiClient): {
  handler: ToolHandler;
  registeredSchema: Record<string, z.ZodType>;
} {
  let handler: ToolHandler | undefined;
  let schema: Record<string, z.ZodType> | undefined;
  const registerTool = vi.fn(
    (
      _name: string,
      config: { inputSchema: Record<string, z.ZodType> },
      callback: ToolHandler
    ): void => {
      handler = callback;
      schema = config.inputSchema;
    }
  );

  registerCreateDocument({ registerTool } as never, apiClient);

  if (!(handler && schema)) {
    throw new Error("Tool handler was not registered");
  }

  return { handler, registeredSchema: schema };
}

const BASE_INPUT = {
  title: "My Feature",
  type: DocumentType.Feature,
  content: "Initial content",
};

describe("create-document MCP tool", () => {
  const apiClient = { post: vi.fn() } as unknown as ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      slug: "FEA-1",
      type: DocumentType.Feature,
    });
  });

  it("registers assigneeId, approverId, priority, fileName, status and repositorySelection in the inputSchema", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    expect(registeredSchema).toHaveProperty("assigneeId");
    expect(registeredSchema).toHaveProperty("approverId");
    expect(registeredSchema).toHaveProperty("priority");
    expect(registeredSchema).toHaveProperty("fileName");
    expect(registeredSchema).toHaveProperty("status");
    expect(registeredSchema).toHaveProperty("repositorySelection");
  });

  it("forwards assigneeId to the POST body", async () => {
    const userId = "019c2991-0bce-76bc-bc7e-a4750929f668";
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, assigneeId: userId });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ assigneeId: userId })
    );
  });

  it("forwards approverId to the POST body", async () => {
    const userId = "019c2991-0bce-76bc-bc7e-a4750929f668";
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, approverId: userId });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ approverId: userId })
    );
  });

  it("forwards priority to the POST body", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, priority: Priority.High });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ priority: Priority.High })
    );
  });

  it("forwards fileName to the POST body", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, fileName: "my-feature.md" });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ fileName: "my-feature.md" })
    );
  });

  it("forwards repositorySelection to the POST body", async () => {
    const repoSelection = { primary: { fullName: "org/repo" } };
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, repositorySelection: repoSelection });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ repositorySelection: repoSelection })
    );
  });

  it("sends TRIAGE status for Features when status is omitted", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, type: DocumentType.Feature });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ status: FeatureStatus.Triage })
    );
  });

  it("sends explicit status for Features instead of TRIAGE default", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({
      ...BASE_INPUT,
      type: DocumentType.Feature,
      status: FeatureStatus.Backlog,
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ status: FeatureStatus.Backlog })
    );
  });

  it("sends no status field for non-Feature types when status is omitted", async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      slug: "PRD-1",
      type: DocumentType.Prd,
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, type: DocumentType.Prd });

    const calledBody = (apiClient.post as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Record<string, unknown>;
    expect(calledBody).not.toHaveProperty("status");
  });

  it("marks projectId as required in the inputSchema (matches API createDocumentValidator)", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    // The API's createDocumentValidator is a .strict() schema with projectId
    // required, so POST /documents with projectId omitted fails schema
    // validation (400) before the resolve step ever runs. Mirror that MCP-side:
    // the tool schema must reject a missing projectId too, not tell the LLM the
    // field is optional (FEA-2886). (notFoundResponse("Project") only applies to
    // the separate case where a projectId is supplied but doesn't resolve.)
    expect(registeredSchema.projectId.safeParse(undefined).success).toBe(false);
    expect(registeredSchema.projectId.safeParse("PRO-7").success).toBe(true);
  });

  it("rejects a non-UUID string for assigneeId via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const result = registeredSchema.assigneeId.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID string for approverId via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const result = registeredSchema.approverId.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
  });

  it("accepts a valid repositorySelection shape with fullName and optional branch", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const repoSchema = registeredSchema.repositorySelection;
    const result = repoSchema.safeParse({
      primary: { fullName: "org/repo", branch: "main" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a repositorySelection missing primary.fullName", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const repoSchema = registeredSchema.repositorySelection;
    const result = repoSchema.safeParse({ primary: {} });
    expect(result.success).toBe(false);
  });
});
