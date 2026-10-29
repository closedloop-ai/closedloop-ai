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

const TOOL_NAME = "tag-artifact";

// The "withholds from write-only" case is load-bearing: tag-artifact opens with
// GET /documents/{id} and GET /tags before it writes. apps/api's withAnyAuth
// defaults a GET under an sk_live_ key to requiredScopes: ["read"], so a grant
// that carries only "write" would be offered a tool that 403s on its first call.
// Listing READ_SCOPE in requiredScopes prevents that — and this test is the
// assertion that catches the scope being accidentally dropped.
const SANITY_READ_TOOL = "list-documents";

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

describe("tag-artifact tool registration gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers tag-artifact for read-and-write sessions", async () => {
    const readAndWrite = await registeredToolNames([READ_SCOPE, WRITE_SCOPE]);
    expect(readAndWrite).toContain(TOOL_NAME);
  });

  it("withholds tag-artifact from write-only sessions", async () => {
    // This is the key case: write alone is not enough because tag-artifact
    // must call GET /documents/{id} and GET /tags first.
    const writeOnly = await registeredToolNames([WRITE_SCOPE]);
    expect(writeOnly).not.toContain(TOOL_NAME);
    // Confirm write-scoped tools did register so this is not a no-op pass.
    expect(writeOnly).toContain("create-artifact-link");
  });

  it("withholds tag-artifact from read-only sessions", async () => {
    const readOnly = await registeredToolNames([READ_SCOPE]);
    expect(readOnly).not.toContain(TOOL_NAME);
    // Confirm read-scoped tools registered, so absence is the gate working.
    expect(readOnly).toContain(SANITY_READ_TOOL);
  });
});
