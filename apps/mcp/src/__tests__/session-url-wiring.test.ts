import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * ISS-6570 production-wiring regression. The unit tests prove
 * `createUrlBuilder` in isolation; this suite drives `createMcpServer` itself
 * so the whole chain — org slug resolved from the DB per session, builder
 * created per session, third `register(server, apiClient, urls)` argument —
 * is pinned. A module-level slug (the original bug), a hoisted singleton
 * builder, or a dropped third argument all fail here.
 */

// index.ts reads INTERNAL_API_SECRET at module load and throws without it —
// same vi.hoisted pattern as delete-artifact-link-registration.test.ts.
const { originalInternalApiSecret } = vi.hoisted(() => {
  const original = process.env.INTERNAL_API_SECRET;
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  return { originalInternalApiSecret: original };
});

vi.mock("../api-client.js", () => ({
  checkApiReachable: vi.fn(),
  createApiClient: vi.fn(() => ({
    post: vi.fn(async () => ({ received: true })),
  })),
  verifyApiKey: vi.fn(),
}));

const RENAMED_ORG_ID = "org-renamed-id";
const RENEWED_ORG_ID = "org-renewed-id";
/** Org whose slug lookup REJECTS, as opposed to resolving `null` (no such org). */
const DB_FAILURE_ORG_ID = "org-db-failure-id";
const DB_FAILURE_MESSAGE = "connection terminated unexpectedly";

const ORG_SLUGS_BY_ID: Record<string, string> = {
  "org-a-id": "org-a",
  "org-b-id": "org-b",
  [RENAMED_ORG_ID]: "before-rename",
  [RENEWED_ORG_ID]: "renew-before",
};

/** Let an in-flight background slug refresh settle. */
function flushPendingRefresh(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

vi.mock("@repo/database", () => {
  const db = {
    organization: {
      findUnique: ({ where }: { where: { id: string } }) => {
        if (where.id === DB_FAILURE_ORG_ID) {
          return Promise.reject(new Error(DB_FAILURE_MESSAGE));
        }
        const slug = ORG_SLUGS_BY_ID[where.id];
        return Promise.resolve(slug ? { slug } : null);
      },
    },
  };
  const withDb = Object.assign(
    async <T>(fn: (client: typeof db) => Promise<T> | T): Promise<T> => fn(db),
    {
      tx: async <T>(fn: (client: typeof db) => Promise<T>): Promise<T> =>
        fn(db),
    }
  );
  return { withDb };
});

import { __testables } from "../index.js";
import { READ_SCOPE, WRITE_SCOPE } from "../oauth-scopes.js";
import { ORG_SLUG_TTL_MS } from "../session-urls.js";

const { createMcpServer } = __testables;

afterAll(() => {
  if (originalInternalApiSecret === undefined) {
    Reflect.deleteProperty(process.env, "INTERNAL_API_SECRET");
    return;
  }
  process.env.INTERNAL_API_SECRET = originalInternalApiSecret;
});

type ToolHandler = (
  input: Record<string, unknown>,
  extra: Record<string, unknown>
) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

async function captureAddLoopEventHandler(
  organizationId: string
): Promise<ToolHandler> {
  let handler: ToolHandler | undefined;
  const spy = vi
    .spyOn(McpServer.prototype, "registerTool")
    .mockImplementation((name: string, _config: unknown, callback: unknown) => {
      if (name === "add-loop-event") {
        handler = callback as ToolHandler;
      }
      return undefined as never;
    });
  try {
    await createMcpServer(
      {
        organizationId,
        scopes: [READ_SCOPE, WRITE_SCOPE],
        userId: "user_1",
      },
      "sk_live_test",
      [READ_SCOPE, WRITE_SCOPE]
    );
  } finally {
    spy.mockRestore();
  }
  if (!handler) {
    throw new Error("add-loop-event was not registered");
  }
  return handler;
}

async function drivenWebUrl(handler: ToolHandler): Promise<string> {
  const result = await handler({ loopId: "loop-1", message: "status" }, {});
  if (result.isError) {
    throw new Error(`tool handler errored: ${result.content[0]?.text}`);
  }
  const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
    webUrl?: string;
  };
  return payload.webUrl ?? "";
}

describe("per-session webUrl org slugs (ISS-6570)", () => {
  it("keeps each session's webUrls on its own org slug across interleaved session creation", async () => {
    const orgA = await captureAddLoopEventHandler("org-a-id");
    const orgB = await captureAddLoopEventHandler("org-b-id");

    // Drive org A only AFTER org B's session initialized — the original bug
    // stamped whichever org initialized last into every session's webUrls.
    expect(await drivenWebUrl(orgB)).toBe(
      "https://app.closedloop.ai/org-b/loops/loop-1"
    );
    expect(await drivenWebUrl(orgA)).toBe(
      "https://app.closedloop.ai/org-a/loops/loop-1"
    );
  });

  it("degrades to org-less webUrls when the org slug cannot be resolved", async () => {
    const handler = await captureAddLoopEventHandler("unknown-org-id");
    expect(await drivenWebUrl(handler)).toBe(
      "https://app.closedloop.ai/loops/loop-1"
    );
  });

  // Distinct from the case above: there `findUnique` RESOLVES null (no such
  // org), which never reaches the catch. Here the lookup REJECTS, so the
  // session must still initialize instead of failing server creation outright.
  it("still initializes with org-less webUrls when the org slug lookup rejects", async () => {
    const handler = await captureAddLoopEventHandler(DB_FAILURE_ORG_ID);
    expect(await drivenWebUrl(handler)).toBe(
      "https://app.closedloop.ai/loops/loop-1"
    );
  });

  // A session is evicted only on INACTIVITY, so one that keeps calling tools
  // lives indefinitely. If it kept the slug it captured at startup, a rename
  // plus another org claiming the released slug would put this session's URLs
  // in the new owner's namespace — ISS-6570 again, just delayed.
  it("drops a stale org slug rather than emit it, then adopts the org's renamed slug", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const handler = await captureAddLoopEventHandler(RENAMED_ORG_ID);
      expect(await drivenWebUrl(handler)).toBe(
        "https://app.closedloop.ai/before-rename/loops/loop-1"
      );

      // The org renames; "before-rename" is now free for another tenant.
      ORG_SLUGS_BY_ID[RENAMED_ORG_ID] = "after-rename";
      vi.setSystemTime(Date.now() + ORG_SLUG_TTL_MS + 1);

      expect(await drivenWebUrl(handler)).toBe(
        "https://app.closedloop.ai/loops/loop-1"
      );

      const refreshed = await vi.waitFor(async () => {
        const url = await drivenWebUrl(handler);
        expect(url).not.toBe("https://app.closedloop.ai/loops/loop-1");
        return url;
      });
      expect(refreshed).toBe(
        "https://app.closedloop.ai/after-rename/loops/loop-1"
      );
    } finally {
      ORG_SLUGS_BY_ID[RENAMED_ORG_ID] = "before-rename";
      vi.useRealTimers();
    }
  });

  // The expiry above is the safety net, not the normal path. A session being
  // driven continuously should renew its slug BEFORE the binding expires, so it
  // never drops an org-less URL into an otherwise healthy conversation.
  it("renews a live session's slug before expiry instead of degrading", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const handler = await captureAddLoopEventHandler(RENEWED_ORG_ID);
      expect(await drivenWebUrl(handler)).toBe(
        "https://app.closedloop.ai/renew-before/loops/loop-1"
      );

      ORG_SLUGS_BY_ID[RENEWED_ORG_ID] = "renew-after";

      // Past half-life: the binding is still trusted, so the URL keeps its slug
      // — and this call is what kicks off the background renewal.
      vi.setSystemTime(Date.now() + ORG_SLUG_TTL_MS / 2 + 1);
      expect(await drivenWebUrl(handler)).toBe(
        "https://app.closedloop.ai/renew-before/loops/loop-1"
      );
      await flushPendingRefresh();

      // Another half-life. More than a full TTL has now elapsed since the
      // original binding, so without that early renewal this would be org-less.
      vi.setSystemTime(Date.now() + ORG_SLUG_TTL_MS / 2 + 1);
      expect(await drivenWebUrl(handler)).toBe(
        "https://app.closedloop.ai/renew-after/loops/loop-1"
      );
    } finally {
      ORG_SLUGS_BY_ID[RENEWED_ORG_ID] = "renew-before";
      vi.useRealTimers();
    }
  });
});
