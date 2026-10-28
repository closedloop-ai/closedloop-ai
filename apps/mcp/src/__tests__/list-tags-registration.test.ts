import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `index.ts` reads `INTERNAL_API_SECRET` at module load and throws without it,
 * so the value has to exist before the static import below is evaluated —
 * which is exactly what `vi.hoisted` is for. Setting it in a `beforeAll`
 * instead would force a dynamic `await import()`, and the module is imported
 * ONCE for the whole file: scope gating is a pure function of the
 * `grantedScopes` argument, so the per-case module reset the sibling
 * registration suites do buys nothing and costs a multi-second transform of a
 * 113 KB module on every case.
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
import { DELETE_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../oauth-scopes.js";

const { createMcpServer } = __testables;

const CONTEXT = {
  organizationId: "org_1",
  scopes: [READ_SCOPE, WRITE_SCOPE, DELETE_SCOPE] as const,
  userId: "user_1",
};

const TOOL_NAME = "list-tags";

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

describe("list-tags tool registration gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers list-tags for read-scoped sessions", async () => {
    const readOnly = await registeredToolNames([READ_SCOPE]);
    expect(readOnly).toContain(TOOL_NAME);
  });

  it("withholds list-tags from sessions with no scopes", async () => {
    const emptyScopes = await registeredToolNames([]);
    expect(emptyScopes).not.toContain(TOOL_NAME);
    // Confirm that tool registration ran — the scope-free "ping" tool should
    // still appear so this assertion cannot pass from an empty registration pass.
    expect(emptyScopes).toContain("ping");
  });
});
