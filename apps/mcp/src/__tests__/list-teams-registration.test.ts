import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `index.ts` reads `INTERNAL_API_SECRET` at module load and throws without it,
 * so the value has to exist before the static import below is evaluated. Scope
 * gating is a pure function of the `grantedScopes` argument, so the module is
 * imported once for the whole file.
 */
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

const { createMcpServer } = __testables;

const CONTEXT = {
  organizationId: "org_1",
  scopes: ["read", "write", "delete"] as const,
  userId: "user_1",
};
const TOOL_NAME = "list-teams";

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

describe("list-teams tool registration gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers list-teams for read-only sessions", async () => {
    const readOnly = await registeredToolNames(["read"]);
    expect(readOnly).toContain(TOOL_NAME);
  });

  /**
   * The scope model is flat — `write` does not imply `read` — so a write-only
   * grant must not be offered this tool. It calls `GET /teams`, which
   * `withAnyAuth` gates on the `read` scope; registering it here would hand the
   * session a tool that 403s on its first call.
   */
  it("withholds list-teams from write-only sessions", async () => {
    const writeOnly = await registeredToolNames(["write"]);
    expect(writeOnly).not.toContain(TOOL_NAME);
    expect(writeOnly).toContain("create-project");
  });

  it("withholds list-teams from delete-only sessions", async () => {
    const deleteOnly = await registeredToolNames(["delete"]);
    expect(deleteOnly).not.toContain(TOOL_NAME);
  });

  it("withholds list-teams from empty scopes", async () => {
    const emptyScopes = await registeredToolNames([]);
    expect(emptyScopes).not.toContain(TOOL_NAME);
  });

  it("registers list-teams alongside the project tools for a full grant", async () => {
    const full = await registeredToolNames(["read", "write", "delete"]);
    expect(full).toContain(TOOL_NAME);
    expect(full).toContain("list-projects");
  });
});
