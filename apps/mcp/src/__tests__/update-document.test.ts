import { Priority } from "@repo/api/src/types/common.js";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { registerUpdateDocument } from "../tools/update-document.js";
import {
  createToolHarnessWithMock,
  registeredToolConfig,
} from "./fixtures/tool-harness.js";
import {
  expectIssue,
  ISO_DATE_UNION_REJECTION,
  UUID_REJECTION,
  ZodIssueCode,
} from "./fixtures/zod-issues.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}>;

const VALID_DUE_DATE = "2026-07-24T05:00:00.000Z";

function createToolHarness(apiClient: ApiClient): {
  handler: ToolHandler;
  registeredSchema: Record<string, z.ZodType>;
} {
  const { handler, registerTool } = createToolHarnessWithMock(
    registerUpdateDocument,
    apiClient
  );
  const registeredSchema = registeredToolConfig(registerTool).inputSchema;
  return { handler, registeredSchema };
}

describe("update-document MCP tool", () => {
  const apiClient = { put: vi.fn() } as unknown as ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers with assigneeId and dueDate in the inputSchema", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    expect(registeredSchema).toHaveProperty("assigneeId");
    expect(registeredSchema).toHaveProperty("dueDate");
    expect(registeredSchema).toHaveProperty("expectedStatus");
    expect(registeredSchema).toHaveProperty("expectedPriority");
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

    await handler({ documentId: "FEA-42", status: IssueStatus.InProgress });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      status: IssueStatus.InProgress,
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

  it("forwards expectedStatus with a status update", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      status: IssueStatus.Done,
    });
    const { handler } = createToolHarness(apiClient);

    await handler({
      documentId: "FEA-42",
      expectedStatus: IssueStatus.InReview,
      status: IssueStatus.Done,
    });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      expectedStatus: IssueStatus.InReview,
      status: IssueStatus.Done,
    });
  });

  it("rejects a non-UUID string for assigneeId via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    expectIssue(
      registeredSchema.assigneeId.safeParse("not-a-uuid"),
      [],
      UUID_REJECTION
    );
  });

  it("forwards priority to apiClient.put body", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      priority: Priority.High,
    });
    const { handler } = createToolHarness(apiClient);

    const result = await handler({
      documentId: "FEA-42",
      priority: Priority.High,
    });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      priority: Priority.High,
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      priority: Priority.High,
    });
  });

  it("forwards an explicit null priority as a CLEAR, distinctly from omitting it (ISS-9665)", async () => {
    // Three states, three different requests. `priority: null` clears the
    // field; an omitted key leaves it alone; a member sets it. Before ISS-9665
    // the input schema was `z.enum(Priority)`, so an API-key caller could set a
    // priority and never clear one — the honest representation the API now
    // accepts was unreachable from this tool. `pickDefined` strips only
    // `undefined`, so the null must survive into the body.
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      priority: null,
    });
    const { handler, registeredSchema } = createToolHarness(apiClient);

    expect(registeredSchema.priority.safeParse(null).success).toBe(true);

    const result = await handler({ documentId: "FEA-42", priority: null });

    const calledBody = (apiClient.put as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Record<string, unknown>;
    // `toHaveProperty` with null, not `toMatchObject` — an omitted key would
    // satisfy a looser matcher and is the exact confusion under test.
    expect(calledBody).toHaveProperty("priority", null);
    expect(JSON.parse(result.content[0].text)).toHaveProperty("priority", null);
  });

  it("forwards an explicit null projectId as a CLEAR, distinctly from omitting it (ISS-12858)", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: null,
    });
    const { handler, registeredSchema } = createToolHarness(apiClient);

    expect(registeredSchema.projectId.safeParse(null).success).toBe(true);

    await handler({ documentId: "FEA-42", projectId: null });
    await handler({ documentId: "FEA-42", title: "Renamed" });

    const calls = (apiClient.put as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[1]).toEqual({ projectId: null });
    expect(calls[1]?.[1]).toEqual({ title: "Renamed" });
    expect(calls[1]?.[1]).not.toHaveProperty("projectId");
  });

  it("forwards expectedPriority as a stale-write guard, null included (ISS-9440)", async () => {
    // The agent-facing half of the precondition. Same three states as
    // `priority` above and for the same reason: omitting the key leaves the
    // write unguarded, a member asserts that member, and `null` asserts the
    // artifact currently holds NO priority — which is the guard an agent needs
    // most, since unset→member is the write this tool makes most often. Without
    // the key on the schema the server's 409 is unreachable from here.
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      priority: Priority.High,
    });
    const { handler, registeredSchema } = createToolHarness(apiClient);

    expect(registeredSchema.expectedPriority.safeParse(null).success).toBe(
      true
    );

    await handler({
      documentId: "FEA-42",
      expectedPriority: null,
      priority: Priority.High,
    });

    const calledBody = (apiClient.put as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Record<string, unknown>;
    expect(calledBody).toHaveProperty("expectedPriority", null);
    expect(calledBody).toHaveProperty("priority", Priority.High);
  });

  it("forwards a member expectedPriority and omits the key when unguarded", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
    });
    const { handler } = createToolHarness(apiClient);

    await handler({
      documentId: "FEA-42",
      expectedPriority: Priority.Low,
      priority: Priority.Urgent,
    });
    await handler({ documentId: "FEA-42", priority: Priority.Urgent });

    const put = apiClient.put as ReturnType<typeof vi.fn>;
    expect(put.mock.calls[0]?.[1]).toHaveProperty(
      "expectedPriority",
      Priority.Low
    );
    expect(put.mock.calls[1]?.[1]).not.toHaveProperty("expectedPriority");
  });

  it("rejects an invalid expectedPriority value via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    expectIssue(registeredSchema.expectedPriority.safeParse("CRITICAL"), [], {
      code: ZodIssueCode.InvalidValue,
      values: Object.values(Priority),
    });
  });

  it("forwards dueDate to apiClient.put body", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ documentId: "FEA-42", dueDate: VALID_DUE_DATE });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      dueDate: VALID_DUE_DATE,
    });
  });

  it("forwards null dueDate to clear it", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ documentId: "FEA-42", dueDate: null });

    expect(apiClient.put).toHaveBeenCalledWith("/documents/FEA-42", {
      dueDate: null,
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

  it("omits priority, dueDate, approverId and fileName from body when not provided", async () => {
    (apiClient.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ documentId: "FEA-42", title: "Updated" });

    const calledBody = (apiClient.put as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Record<string, unknown>;
    expect(calledBody).not.toHaveProperty("priority");
    expect(calledBody).not.toHaveProperty("dueDate");
    expect(calledBody).not.toHaveProperty("approverId");
    expect(calledBody).not.toHaveProperty("fileName");
  });

  it("rejects an invalid priority value via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    expectIssue(registeredSchema.priority.safeParse("CRITICAL"), [], {
      code: ZodIssueCode.InvalidValue,
      values: Object.values(Priority),
    });
  });

  it("rejects a non-UUID string for approverId via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    expectIssue(
      registeredSchema.approverId.safeParse("not-a-uuid"),
      [],
      UUID_REJECTION
    );
  });

  it("accepts ISO date and timezone-qualified datetime dueDate values", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    expect(registeredSchema.dueDate.safeParse("2026-07-24").success).toBe(true);
    expect(registeredSchema.dueDate.safeParse(VALID_DUE_DATE).success).toBe(
      true
    );
  });

  it("rejects invalid dueDate strings via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    expectIssue(
      registeredSchema.dueDate.safeParse("2026-07-32"),
      [],
      ISO_DATE_UNION_REJECTION
    );
  });
});
