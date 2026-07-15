import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// createMcpServer builds an ApiClient and resolves the org slug from the DB;
// neither is needed to observe feature-flag gating of the read tools.
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

const isMcpFeatureFlagEnabled = vi.fn<[string, string], Promise<boolean>>();
vi.mock("../feature-flags.js", () => ({
  EMERGENT_FEATURE_FLAG: "emergent",
  isMcpFeatureFlagEnabled: (flag: string, distinctId: string) =>
    isMcpFeatureFlagEnabled(flag, distinctId),
}));

const ORIGINAL_ENV = { ...process.env };

const CONTEXT = {
  userId: "user_1",
  organizationId: "org_1",
  scopes: ["read"] as const,
  clerkUserId: "clerk_user_1",
};

const READ_TOOLS = ["list-agent-sessions", "get-agent-session-transcript"];

/**
 * Run the real createMcpServer gating loop and capture every tool name it
 * registers, by spying on the SDK's registerTool. index.js reads required env
 * at module load, so set it before the dynamic import.
 */
async function registeredToolNames(flagEnabled: boolean): Promise<string[]> {
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  isMcpFeatureFlagEnabled.mockResolvedValue(flagEnabled);
  const { __testables } = await import("../index.js");
  const names: string[] = [];
  const spy = vi
    .spyOn(McpServer.prototype, "registerTool")
    .mockImplementation((name: string) => {
      names.push(name);
      return undefined as never;
    });
  try {
    await __testables.createMcpServer(CONTEXT, "sk_live_test", ["read"]);
  } finally {
    spy.mockRestore();
  }
  return names;
}

describe("agent-session read tool registration gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("registers the read tools (read scope only) when the emergent flag is enabled", async () => {
    const names = await registeredToolNames(true);
    for (const tool of READ_TOOLS) {
      expect(names).toContain(tool);
    }
    expect(isMcpFeatureFlagEnabled).toHaveBeenCalledWith(
      "emergent",
      "clerk_user_1"
    );
  });

  it("withholds the read tools when the emergent flag is disabled", async () => {
    const names = await registeredToolNames(false);
    for (const tool of READ_TOOLS) {
      expect(names).not.toContain(tool);
    }
    // Sanity check: ungated tools still register, so absence is the flag gate
    // at work and not an empty/failed registration pass.
    expect(names).toContain("list-documents");
  });
});
