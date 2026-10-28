import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import type { ApiClient } from "../api-client.js";
import { registerListTeams } from "../tools/list-teams.js";
import { MAX_PAGE_LIMIT } from "../tools/tool-utils.js";
import {
  createToolHarnessWithMock,
  parseToolPayload,
} from "./fixtures/tool-harness.js";
import { expectIssue, ZodIssueCode } from "./fixtures/zod-issues.js";

const TEAM_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_TEAM_ID = "2b1f0c3a-1111-4222-8333-444455556666";

const apiClient = { get: vi.fn() };

const { handler, registerTool } = createToolHarnessWithMock(
  registerListTeams,
  apiClient as unknown as ApiClient
);

const registeredName = registerTool.mock.calls[0]![0] as string;
const registeredConfig = registerTool.mock.calls[0]![1] as {
  description: string;
  inputSchema: Record<string, ZodType>;
};

function teamRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEAM_ID,
    organizationId: "org-1",
    name: "Platform",
    slug: "platform",
    memberCount: 6,
    projectCount: 12,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-15T10:00:00Z",
    ...overrides,
  };
}

describe("list-teams tool registration", () => {
  it("registers the tool as list-teams", () => {
    expect(registeredName).toBe("list-teams");
  });

  it("names the create-project team requirement it exists to serve", () => {
    expect(registeredConfig.description).toContain("create-project");
    expect(registeredConfig.description.toLowerCase()).toContain("team");
  });

  it("exposes limit and offset paging inputs", () => {
    expect(registeredConfig.inputSchema).toHaveProperty("limit");
    expect(registeredConfig.inputSchema).toHaveProperty("offset");
    expectIssue(registeredConfig.inputSchema.limit.safeParse(101), [], {
      code: ZodIssueCode.TooBig,
      origin: "number",
      maximum: MAX_PAGE_LIMIT,
    });
    expectIssue(registeredConfig.inputSchema.limit.safeParse(0), [], {
      code: ZodIssueCode.TooSmall,
      origin: "number",
      minimum: 1,
    });
    expectIssue(registeredConfig.inputSchema.offset.safeParse(-1), [], {
      code: ZodIssueCode.TooSmall,
      origin: "number",
      minimum: 0,
    });
  });
});

describe("list-teams MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads GET /teams", async () => {
    apiClient.get.mockResolvedValue([teamRow()]);

    await handler({});

    expect(apiClient.get).toHaveBeenCalledWith("/teams");
  });

  it("shapes each team down to the fields a caller picks one by", async () => {
    apiClient.get.mockResolvedValue([teamRow()]);

    const payload = parseToolPayload(await handler({})) as {
      items: Record<string, unknown>[];
    };

    expect(payload.items).toEqual([
      {
        id: TEAM_ID,
        name: "Platform",
        slug: "platform",
        memberCount: 6,
        projectCount: 12,
        updatedAt: "2025-01-15T10:00:00Z",
      },
    ]);
  });

  it("returns null for a field the API omitted rather than inventing one", async () => {
    // A version-skewed server that stops sending counts must degrade to
    // "unknown", never to a fabricated 0 that reads as a real empty team.
    apiClient.get.mockResolvedValue([
      teamRow({ memberCount: undefined, projectCount: undefined, slug: 42 }),
    ]);

    const payload = parseToolPayload(await handler({})) as {
      items: Record<string, unknown>[];
    };

    expect(payload.items[0]).toMatchObject({
      id: TEAM_ID,
      memberCount: null,
      projectCount: null,
      slug: null,
    });
  });

  it("paginates with the caller's limit and offset", async () => {
    apiClient.get.mockResolvedValue([
      teamRow(),
      teamRow({ id: OTHER_TEAM_ID, name: "Growth", slug: "growth" }),
    ]);

    const payload = parseToolPayload(
      await handler({ limit: 1, offset: 1 })
    ) as {
      total: number;
      returned: number;
      hasMore: boolean;
      nextOffset: number | null;
      items: { id: string }[];
    };

    expect(payload.total).toBe(2);
    expect(payload.returned).toBe(1);
    expect(payload.hasMore).toBe(false);
    expect(payload.items.map((item) => item.id)).toEqual([OTHER_TEAM_ID]);
  });

  it("reports more pages when the page does not reach the end", async () => {
    apiClient.get.mockResolvedValue([
      teamRow(),
      teamRow({ id: OTHER_TEAM_ID, name: "Growth" }),
    ]);

    const payload = parseToolPayload(await handler({ limit: 1 })) as {
      hasMore: boolean;
      nextOffset: number | null;
    };

    expect(payload.hasMore).toBe(true);
    expect(payload.nextOffset).toBe(1);
  });

  it("returns an empty page for an org with no teams", async () => {
    apiClient.get.mockResolvedValue([]);

    const payload = parseToolPayload(await handler({})) as {
      total: number;
      items: unknown[];
    };

    expect(payload.total).toBe(0);
    expect(payload.items).toEqual([]);
  });

  it("surfaces an API failure as a tool error", async () => {
    apiClient.get.mockRejectedValue(new Error("boom"));

    const result = await handler({});

    expect(result.isError).toBe(true);
  });
});
