import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { originalInternalApiSecret } = vi.hoisted(() => {
  const original = process.env.INTERNAL_API_SECRET;
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  return { originalInternalApiSecret: original };
});

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

import { __testables } from "../index.js";
import { DELETE_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../oauth-scopes.js";

const { createMcpServer } = __testables;

describe("get-document-content tool registration gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the exact catalog and runtime name for read-scoped sessions", async () => {
    const readOnly = await registeredToolNames([READ_SCOPE]);

    expect(readOnly).toContain(TOOL_NAME);
  });

  it("withholds the tool from sessions without read scope", async () => {
    const emptyScopes = await registeredToolNames([]);

    expect(emptyScopes).not.toContain(TOOL_NAME);
    expect(emptyScopes).toContain("ping");
  });
});

afterAll(() => {
  if (originalInternalApiSecret === undefined) {
    Reflect.deleteProperty(process.env, "INTERNAL_API_SECRET");
    return;
  }
  process.env.INTERNAL_API_SECRET = originalInternalApiSecret;
});

async function registeredToolNames(grantedScopes: string[]): Promise<string[]> {
  const names: string[] = [];
  const spy = vi
    .spyOn(McpServer.prototype, "registerTool")
    .mockImplementation((name: string) => {
      names.push(name);
      return undefined as never;
    });
  try {
    await createMcpServer(CONTEXT, "sk_live_test", grantedScopes);
  } finally {
    spy.mockRestore();
  }
  return names;
}

const CONTEXT = {
  organizationId: "org_1",
  scopes: [READ_SCOPE, WRITE_SCOPE, DELETE_SCOPE] as const,
  userId: "user_1",
};

const TOOL_NAME = "get-document-content";
