import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentComponentSortKey } from "@repo/api/src/types/agent-component.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

// createMcpServer builds an ApiClient and resolves the org slug from the DB;
// neither is needed to observe registration of the read tools.
vi.mock("../api-client.js", () => ({
  verifyApiKey: vi.fn(),
  checkApiReachable: vi.fn(),
  createApiClient: vi.fn(() => ({})),
}));

vi.mock("@repo/database", () => {
  const withDb = Object.assign(
    async <T>(fn: (db: Record<string, never>) => Promise<T> | T): Promise<T> =>
      fn({}),
    {
      tx: async <T>(
        fn: (db: Record<string, never>) => Promise<T>
      ): Promise<T> => fn({}),
    }
  );
  return { withDb };
});

const ORIGINAL_ENV = { ...process.env };

const CONTEXT = {
  userId: "user_1",
  organizationId: "org_1",
  scopes: ["read"] as const,
};

const READ_TOOLS = ["list-agent-components", "get-agent-component"];

const LIST_TOOL = "list-agent-components";

/** Every `"quoted"` value in an input description, in the order they appear. */
const QUOTED_VALUE_RE = /"([^"]+)"/g;

type RegisteredTool = {
  name: string;
  config: { inputSchema?: Record<string, z.ZodTypeAny> };
};

/**
 * Run the real createMcpServer registration loop and capture every tool it
 * registers, by spying on the SDK's registerTool. index.js reads required env
 * at module load, so set it before the dynamic import.
 */
async function registeredTools(
  grantedScopes: readonly string[]
): Promise<RegisteredTool[]> {
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  const { __testables } = await import("../index.js");
  const tools: RegisteredTool[] = [];
  const spy = vi
    .spyOn(McpServer.prototype, "registerTool")
    .mockImplementation((name: string, config: RegisteredTool["config"]) => {
      tools.push({ name, config });
      return undefined as never;
    });
  try {
    await __testables.createMcpServer(CONTEXT, "sk_live_test", [
      ...grantedScopes,
    ]);
  } finally {
    spy.mockRestore();
  }
  return tools;
}

async function registeredToolNames(
  grantedScopes: readonly string[]
): Promise<string[]> {
  const tools = await registeredTools(grantedScopes);
  return tools.map((tool) => tool.name);
}

describe("agent-component read tool registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("registers the component read tools with read scope", async () => {
    const names = await registeredToolNames(["read"]);
    for (const tool of READ_TOOLS) {
      expect(names).toContain(tool);
    }
    expect(names).toContain("list-documents");
  });

  it("advertises exactly the live AgentComponentSortKey values in the sortBy description", async () => {
    // ISS-4944 (wongk): the registered description is the contract callers read,
    // so assert it through the real registration path rather than against the
    // module constant. It drifted once already — the hand-written list still
    // advertised the `owner` key FEA-4098 removed from the SSOT, which the
    // enum-derived `sortBy` then rejected.
    const tools = await registeredTools(["read"]);
    const sortBy = tools.find((tool) => tool.name === LIST_TOOL)?.config
      .inputSchema?.sortBy;
    const description = sortBy?.description ?? "";

    const advertised = [...description.matchAll(QUOTED_VALUE_RE)].map(
      (match) => match[1]
    );
    expect(advertised).toEqual(Object.values(AgentComponentSortKey));
  });

  it("withholds the component read tools from write-only and empty grants", async () => {
    for (const scopes of [["write"], []] as const) {
      const names = await registeredToolNames(scopes);
      for (const tool of READ_TOOLS) {
        expect(names).not.toContain(tool);
      }
      expect(names).toContain(scopes.length === 0 ? "ping" : "create-project");
    }
  });
});
