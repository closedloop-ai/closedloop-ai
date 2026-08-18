import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tools/tool-utils.js", () => ({
  asRecord: (value: unknown) =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {},
  readString: (value: unknown) => (typeof value === "string" ? value : null),
  buildPaginatedPayload: (
    items: unknown,
    options: { mapItem: (v: unknown) => unknown }
  ) => ({ items: Array.isArray(items) ? items.map(options.mapItem) : [] }),
  buildQuery: (fields: Record<string, string | undefined>) => {
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        query[key] = value;
      }
    }
    return query;
  },
  describeIdOrSlug: () => "id or slug",
  MAX_PAGE_LIMIT: 100,
  withErrorHandling: (fn: () => Promise<unknown>) => fn(),
}));

import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop.js";
import { type ZodRawShape, z } from "zod";
import { registerListLoops } from "../tools/list-loops.js";
import { stubLoopUrls } from "./fixtures/tool-harness.js";

const registerTool = vi.fn();
const apiClient = {
  get: vi.fn(),
};

function registeredInputSchema(): ZodRawShape {
  return registerTool.mock.calls[0]?.[1]?.inputSchema as ZodRawShape;
}

function registeredHandler() {
  return registerTool.mock.calls[0]?.[2] as
    | ((input: Record<string, unknown>) => Promise<unknown>)
    | undefined;
}

describe("list-loops MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue([]);
    registerListLoops(
      { registerTool } as never,
      apiClient as never,
      stubLoopUrls as never
    );
  });

  it("exposes documentId, status, command, projectId, limit, and offset filters", () => {
    const schema = registeredInputSchema();
    expect(Object.keys(schema).sort()).toEqual([
      "command",
      "documentId",
      "limit",
      "offset",
      "projectId",
      "status",
    ]);
  });

  it("accepts a valid command enum value and rejects an unknown one", () => {
    const object = z.object(registeredInputSchema());
    expect(object.safeParse({ command: LoopCommand.Plan }).success).toBe(true);
    expect(object.safeParse({ command: "not-a-command" }).success).toBe(false);
  });

  it("accepts a projectId as either a UUID or a project slug", () => {
    const object = z.object(registeredInputSchema());
    expect(
      object.safeParse({
        projectId: "123e4567-e89b-12d3-a456-426614174000",
      }).success
    ).toBe(true);
    expect(object.safeParse({ projectId: "PRO-7" }).success).toBe(true);
  });

  it("forwards command and projectId to the /loops query", async () => {
    await registeredHandler()?.({
      documentId: "FEA-42",
      status: LoopStatus.Running,
      command: LoopCommand.Execute,
      projectId: "123e4567-e89b-12d3-a456-426614174000",
    });

    expect(apiClient.get).toHaveBeenCalledWith("/loops", {
      documentId: "FEA-42",
      status: LoopStatus.Running,
      command: LoopCommand.Execute,
      projectId: "123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("omits command and projectId from the query when not supplied", async () => {
    await registeredHandler()?.({ documentId: "FEA-42" });

    expect(apiClient.get).toHaveBeenCalledWith("/loops", {
      documentId: "FEA-42",
    });
  });

  it("builds webUrl for loops with an id and returns null for those without", async () => {
    // Covers both arms of `webUrl: id ? urls.buildLoopUrl(id) : null`.
    apiClient.get.mockResolvedValue([
      {
        id: "loop-1",
        status: LoopStatus.Running,
        command: LoopCommand.Manual,
        documentId: "FEA-42",
        createdAt: "2026-08-01T00:00:00.000Z",
        startedAt: "2026-08-01T00:00:01.000Z",
        completedAt: null,
      },
      {
        id: null,
        status: LoopStatus.Failed,
        command: LoopCommand.Manual,
        documentId: "FEA-43",
        createdAt: "2026-08-02T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
      },
    ]);

    const result = (await registeredHandler()?.({})) as
      | { content: { text: string }[] }
      | undefined;
    const payload = JSON.parse(result?.content[0]?.text ?? "{}") as {
      items: { id: string | null; webUrl: string | null }[];
    };

    expect(payload.items[0].webUrl).toBe("https://app.example/loops/loop-1");
    expect(payload.items[1].webUrl).toBeNull();
  });
});
