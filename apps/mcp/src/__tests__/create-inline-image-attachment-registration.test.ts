import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testables } from "../index.js";

const ORIGINAL_ENV = vi.hoisted(() => {
  const originalEnv = { ...process.env };
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  return originalEnv;
});

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

const CONTEXT = {
  userId: "user_1",
  organizationId: "org_1",
  scopes: ["read", "write"] as const,
};
const TOOL_NAME = "create-inline-image-attachment";

async function registeredToolNames(grantedScopes: string[]): Promise<string[]> {
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
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

describe("create-inline-image-attachment tool registration gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("registers create-inline-image-attachment only when the session has write scope", async () => {
    const withWrite = await registeredToolNames(["read", "write"]);
    expect(withWrite).toContain(TOOL_NAME);
  });

  it("withholds create-inline-image-attachment from read-only sessions", async () => {
    const readOnly = await registeredToolNames(["read"]);
    expect(readOnly).not.toContain(TOOL_NAME);
    expect(readOnly).toContain("list-attachments");
  });
});
