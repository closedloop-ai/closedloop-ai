import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// createMcpServer builds an ApiClient and resolves the org slug from the DB;
// neither is needed to observe which tools get gated by write scope.
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
const TOOL_NAME = "move-artifact";

/**
 * Run the real createMcpServer gating loop and capture every tool name it
 * registers, by spying on the SDK's registerTool. This exercises the
 * production write-scope filter rather than scanning source text, so a gate
 * inversion or a renamed `requiresWrite` flag fails the test. index.js reads
 * required env at module load, so set it before the dynamic import.
 */
async function registeredToolNames(grantedScopes: string[]): Promise<string[]> {
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
    await __testables.createMcpServer(CONTEXT, "sk_live_test", grantedScopes);
  } finally {
    spy.mockRestore();
  }
  return names;
}

describe("move-artifact tool registration gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("registers move-artifact only when the session has write scope", async () => {
    const withWrite = await registeredToolNames(["read", "write"]);
    expect(withWrite).toContain(TOOL_NAME);
  });

  it("withholds move-artifact from read-only sessions", async () => {
    const readOnly = await registeredToolNames(["read"]);
    expect(readOnly).not.toContain(TOOL_NAME);
    // Sanity check: read-scoped tools are still registered, so absence is the
    // write gate at work and not an empty/failed registration pass.
    expect(readOnly).toContain("list-documents");
  });
});
