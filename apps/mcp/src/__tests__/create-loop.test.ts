import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tools/tool-utils.js", () => ({
  asRecord: (value: unknown) =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {},
  readString: (value: unknown) => (typeof value === "string" ? value : null),
  buildLoopUrl: (loopId: string) => `https://app.example/loops/${loopId}`,
  describeIdOrSlug: () => "id or slug",
  withErrorHandling: (fn: () => Promise<unknown>) => fn(),
}));

import { type ZodRawShape, z } from "zod";
import { registerCreateLoop } from "../tools/create-loop.js";

const registerTool = vi.fn();
const apiClient = {
  post: vi.fn(),
};

function registeredInputSchema(): ZodRawShape {
  return registerTool.mock.calls[0]?.[1]?.inputSchema as ZodRawShape;
}

function registeredHandler() {
  return registerTool.mock.calls[0]?.[2] as
    | ((input: Record<string, unknown>) => Promise<unknown>)
    | undefined;
}

describe("create-loop MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerCreateLoop({ registerTool } as never, apiClient as never);
  });

  it("registers inputSchema as a ZodRawShape (field map), not a built ZodObject", () => {
    const schema = registeredInputSchema();
    // A raw shape is a plain object of field validators. The SDK-incompatible
    // shape this guards against — a z.object()/z.object().refine() — would
    // instead expose a `.safeParse` method.
    expect(typeof (schema as { safeParse?: unknown }).safeParse).toBe(
      "undefined"
    );
    expect(Object.keys(schema).sort()).toEqual([
      "documentId",
      "prompt",
      "repoBranch",
      "repoFullName",
    ]);
  });

  it("rejects empty-string repo fields via the field-level min(1) constraint", () => {
    const object = z.object(registeredInputSchema());
    expect(
      object.safeParse({
        documentId: "FEA-42",
        repoFullName: "closedloop-ai/symphony-alpha",
        repoBranch: "",
      }).success
    ).toBe(false);
    expect(
      object.safeParse({
        documentId: "FEA-42",
        repoFullName: "",
        repoBranch: "feature/fea-653",
      }).success
    ).toBe(false);
  });

  it("accepts both repoFullName and repoBranch together", async () => {
    apiClient.post.mockResolvedValue({ id: "loop-1" });
    await expect(
      registeredHandler()?.({
        documentId: "FEA-42",
        repoFullName: "closedloop-ai/symphony-alpha",
        repoBranch: "feature/fea-653",
      })
    ).resolves.toBeDefined();
  });

  it("accepts neither repoFullName nor repoBranch", async () => {
    apiClient.post.mockResolvedValue({ id: "loop-1" });
    await expect(
      registeredHandler()?.({ documentId: "FEA-42" })
    ).resolves.toBeDefined();
  });

  it("rejects repoFullName without repoBranch via the handler cross-field check", async () => {
    await expect(
      registeredHandler()?.({
        documentId: "FEA-42",
        repoFullName: "closedloop-ai/symphony-alpha",
      })
    ).rejects.toThrow("must be provided together");
  });

  it("rejects repoBranch without repoFullName via the handler cross-field check", async () => {
    await expect(
      registeredHandler()?.({
        documentId: "FEA-42",
        repoBranch: "feature/fea-653",
      })
    ).rejects.toThrow("must be provided together");
  });

  it("includes the repo when both fields are present", async () => {
    apiClient.post.mockResolvedValue({ id: "loop-1" });
    await registeredHandler()?.({
      documentId: "FEA-42",
      repoFullName: "closedloop-ai/symphony-alpha",
      repoBranch: "feature/fea-653",
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/loops",
      expect.objectContaining({
        documentId: "FEA-42",
        repo: {
          fullName: "closedloop-ai/symphony-alpha",
          branch: "feature/fea-653",
        },
      })
    );
  });

  it("omits the repo when neither field is present", async () => {
    apiClient.post.mockResolvedValue({ id: "loop-1" });
    await registeredHandler()?.({ documentId: "FEA-42" });

    const body = apiClient.post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.repo).toBeUndefined();
  });
});
