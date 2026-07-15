import { Priority } from "@repo/api/src/types/common.js";
import { DocumentStatus, FeatureStatus } from "@repo/api/src/types/document.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { registerUpdateDocument } from "../tools/update-document.js";

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

  registerUpdateDocument({ registerTool } as never, apiClient);

  if (!(handler && schema)) {
    throw new Error("Tool handler was not registered");
  }

  return { handler, registeredSchema: schema };
}

describe("update-document MCP tool", () => {
  const apiClient = { put: vi.fn() } as unknown as ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers with assigneeId in the inputSchema", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    expect(registeredSchema).toHaveProperty("assigneeId");
  });

  it("passes a valid UUID assigneeId to apiClient.put body", async () => {
    const userId = "019c2991-0bce-76bc-bc7e-a4750929f668";
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      assigneeId: userId,
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ documentId: "FEA-42", assigneeId: userId });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      assigneeId: userId,
    });
  });

  it("passes null assigneeId to unassign", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      assigneeId: null,
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ documentId: "FEA-42", assigneeId: null });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      assigneeId: null,
    });
  });

  it("omits assigneeId from body when not provided", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ documentId: "FEA-42", status: FeatureStatus.InProgress });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      status: FeatureStatus.InProgress,
    });
  });

  it("includes assigneeId alongside other fields in a multi-field update", async () => {
    const userId = "019c2991-0bce-76bc-bc7e-a4750929f668";
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      title: "Updated",
      assigneeId: userId,
    });
    const { handler } = createToolHarness(apiClient);

    await handler({
      documentId: "PLN-7",
      title: "Updated",
      status: DocumentStatus.InReview,
      assigneeId: userId,
    });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/PLN-7", {
      title: "Updated",
      status: DocumentStatus.InReview,
      assigneeId: userId,
    });
  });

  it("rejects a non-UUID string for assigneeId via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const assigneeSchema = registeredSchema.assigneeId;
    const result = assigneeSchema.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
  });

  it("forwards priority to apiClient.put body", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ documentId: "FEA-42", priority: Priority.High });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      priority: Priority.High,
    });
  });

  it("forwards approverId to apiClient.put body", async () => {
    const userId = "019c2991-0bce-76bc-bc7e-a4750929f668";
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      approverId: userId,
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ documentId: "FEA-42", approverId: userId });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      approverId: userId,
    });
  });

  it("forwards null approverId to apiClient.put body to clear the approver", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      approverId: null,
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ documentId: "FEA-42", approverId: null });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      approverId: null,
    });
  });

  it("forwards fileName to apiClient.put body", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ documentId: "FEA-42", fileName: "my-feature.md" });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      fileName: "my-feature.md",
    });
  });

  it("omits priority, approverId and fileName from body when not provided", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ documentId: "FEA-42", title: "Updated" });

    const calledBody = (apiClient.put as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Record<string, unknown>;
    expect(calledBody).not.toHaveProperty("priority");
    expect(calledBody).not.toHaveProperty("approverId");
    expect(calledBody).not.toHaveProperty("fileName");
  });

  it("rejects an invalid priority value via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const prioritySchema = registeredSchema.priority;
    const result = prioritySchema.safeParse("CRITICAL");
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID string for approverId via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const approverSchema = registeredSchema.approverId;
    const result = approverSchema.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
  });
});
