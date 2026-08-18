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

const { createMcpServer } = __testables;

const CONTEXT = {
  organizationId: "org_1",
  scopes: ["read", "write", "delete"] as const,
  userId: "user_1",
};
const TOOL_NAME = "delete-artifact-link";

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

describe("delete-artifact-link tool registration gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("withholds delete-artifact-link from read-only sessions", async () => {
    const readOnly = await registeredToolNames(["read"]);
    expect(readOnly).not.toContain(TOOL_NAME);
    expect(readOnly).toContain("list-artifact-links");
  });

  it("withholds delete-artifact-link from write-only sessions", async () => {
    const writeOnly = await registeredToolNames(["write"]);
    expect(writeOnly).not.toContain(TOOL_NAME);
    expect(writeOnly).toContain("create-artifact-link");
  });

  it("withholds delete-artifact-link from wrong similar scopes", async () => {
    const wrongSimilar = await registeredToolNames(["deleted"]);
    expect(wrongSimilar).not.toContain(TOOL_NAME);
  });

  it("withholds delete-artifact-link from empty scopes", async () => {
    const emptyScopes = await registeredToolNames([]);
    expect(emptyScopes).not.toContain(TOOL_NAME);
  });

  it("registers delete-artifact-link for delete-only sessions", async () => {
    const deleteOnly = await registeredToolNames(["delete"]);
    expect(deleteOnly).toContain(TOOL_NAME);
  });

  it("registers delete-artifact-link for read-and-delete sessions", async () => {
    const readAndDelete = await registeredToolNames(["read", "delete"]);
    expect(readAndDelete).toContain(TOOL_NAME);
  });
});
