import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api-client.js", () => ({
  checkApiReachable: vi.fn(),
  createApiClient: vi.fn(() => ({})),
  verifyApiKey: vi.fn(),
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
  organizationId: "org_1",
  scopes: ["read", "delete"] as const,
  userId: "user_1",
};
const TOOL_NAME = "delete-attachment";

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

describe("delete-attachment tool registration gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("withholds delete-attachment from read-only sessions", async () => {
    const readOnly = await registeredToolNames(["read"]);
    expect(readOnly).not.toContain(TOOL_NAME);
    expect(readOnly).toContain("list-attachments");
  });

  it("withholds delete-attachment from write-only sessions", async () => {
    const writeOnly = await registeredToolNames(["write"]);
    expect(writeOnly).not.toContain(TOOL_NAME);
    expect(writeOnly).toContain("upload-attachment");
  });

  it("withholds delete-attachment from wrong similar scopes", async () => {
    const wrongSimilar = await registeredToolNames(["deleted"]);
    expect(wrongSimilar).not.toContain(TOOL_NAME);
  });

  it("withholds delete-attachment from empty scopes", async () => {
    const emptyScopes = await registeredToolNames([]);
    expect(emptyScopes).not.toContain(TOOL_NAME);
  });

  it("registers delete-attachment for delete-only sessions", async () => {
    const deleteOnly = await registeredToolNames(["delete"]);
    expect(deleteOnly).toContain(TOOL_NAME);
  });

  it("registers delete-attachment for read-and-delete sessions", async () => {
    const readAndDelete = await registeredToolNames(["read", "delete"]);
    expect(readAndDelete).toContain(TOOL_NAME);
  });
});
