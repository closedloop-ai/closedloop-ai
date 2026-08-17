import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// createMcpServer builds an ApiClient and resolves the org slug from the DB;
// neither is needed to observe registration of the reporting tools.
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
  scopes: ["read", "write"] as const,
};

const REPORTING_TOOLS = [
  "get-agent-session-usage",
  "get-agent-session-analytics",
];

/**
 * Run the real createMcpServer registration loop and capture every tool name it
 * registers, by spying on the SDK's registerTool. index.js reads required env
 * at module load, so set it before the dynamic import.
 */
async function registeredToolNames(
  grantedScopes: readonly string[]
): Promise<string[]> {
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  const { __testables } = await import("../index.js");
  const names: string[] = [];
  const spy = vi
    .spyOn(McpServer.prototype, "registerTool")
    .mockImplementation((name: string) => {
      names.push(name);
      return undefined as never;
    });
  try {
    await __testables.createMcpServer(CONTEXT, "sk_live_test", [
      ...grantedScopes,
    ]);
  } finally {
    spy.mockRestore();
  }
  return names;
}

describe("agent-session reporting tool registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("registers the reporting tools with read scope", async () => {
    const names = await registeredToolNames(["read"]);
    for (const tool of REPORTING_TOOLS) {
      expect(names).toContain(tool);
    }
    expect(names).toContain("list-documents");
  });

  it("withholds the reporting tools from write-only and empty grants", async () => {
    for (const scopes of [["write"], []] as const) {
      const names = await registeredToolNames(scopes);
      for (const tool of REPORTING_TOOLS) {
        expect(names).not.toContain(tool);
      }
      expect(names).toContain(scopes.length === 0 ? "ping" : "create-project");
    }
  });
});
