import {
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerListArtifactLinks } from "../tools/list-artifact-links.js";
import {
  callToolThroughServer,
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

const FULL_LINK = {
  id: "link-1",
  linkType: LinkType.Produces,
  createdAt: "2026-01-01T00:00:00.000Z",
  source: {
    id: "src-id",
    type: "DOCUMENT",
    subtype: "PRD",
    name: "My PRD",
    slug: "PRD-1",
    externalUrl: null,
  },
  target: {
    id: "tgt-id",
    type: "DOCUMENT",
    subtype: "PLAN",
    name: "My Plan",
    slug: "PLN-1",
    externalUrl: "https://example.com",
  },
};

describe("list-artifact-links MCP tool — query filter arms", () => {
  it("sends no optional filters when only artifactId is provided", async () => {
    const get = vi.fn().mockResolvedValue([FULL_LINK]);
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    await handler({ artifactId: "PRD-1" });

    const [path, query] = get.mock.calls[0] as [string, Record<string, string>];
    expect(path).toBe("/artifact-links/resolved");
    // `paginated` is this tool's own opt-in (ISS-10102), not a caller filter.
    expect(query).toEqual({ artifactId: "PRD-1", paginated: "true" });
    expect(query).not.toHaveProperty("linkType");
    expect(query).not.toHaveProperty("direction");
    expect(query).not.toHaveProperty("mode");
    expect(query).not.toHaveProperty("maxDepth");
  });

  it("includes linkType in query when provided", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    await handler({ artifactId: "PRD-1", linkType: LinkType.Blocks });

    const [, query] = get.mock.calls[0] as [string, Record<string, string>];
    expect(query.linkType).toBe(LinkType.Blocks);
  });

  it("includes direction in query when provided", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    await handler({ artifactId: "PRD-1", direction: LinkDirection.Source });

    const [, query] = get.mock.calls[0] as [string, Record<string, string>];
    expect(query.direction).toBe(LinkDirection.Source);
  });

  it("includes mode in query when provided", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    await handler({ artifactId: "PRD-1", mode: LinkQueryMode.Tree });

    const [, query] = get.mock.calls[0] as [string, Record<string, string>];
    expect(query.mode).toBe(LinkQueryMode.Tree);
  });

  it("includes maxDepth as a string in query when provided", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    await handler({ artifactId: "PRD-1", maxDepth: 3 });

    const [, query] = get.mock.calls[0] as [string, Record<string, string>];
    expect(query.maxDepth).toBe("3");
  });
});

describe("list-artifact-links MCP tool — endpoint shaping arms", () => {
  it("shapes a fully-hydrated link with all endpoint fields present", async () => {
    const get = vi.fn().mockResolvedValue([FULL_LINK]);
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ artifactId: "PRD-1" })
    ) as { items: unknown[] };

    const item = payload.items[0] as Record<string, unknown>;
    expect(item.id).toBe("link-1");
    expect(item.linkType).toBe(LinkType.Produces);
    const source = item.source as Record<string, unknown>;
    expect(source.id).toBe("src-id");
    expect(source.type).toBe("DOCUMENT");
    expect(source.subtype).toBe("PRD");
    expect(source.name).toBe("My PRD");
    expect(source.slug).toBe("PRD-1");
    expect(source.externalUrl).toBeNull();
    const target = item.target as Record<string, unknown>;
    expect(target.externalUrl).toBe("https://example.com");
  });

  it("shapes null for each endpoint field when source and target are missing entirely", async () => {
    const get = vi
      .fn()
      .mockResolvedValue([
        { id: "link-2", linkType: LinkType.RelatesTo, createdAt: null },
      ]);
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ artifactId: "PRD-1" })
    ) as { items: unknown[] };

    const item = payload.items[0] as Record<string, unknown>;
    const source = item.source as Record<string, unknown>;
    const target = item.target as Record<string, unknown>;
    expect(source.id).toBeNull();
    expect(source.type).toBeNull();
    expect(source.subtype).toBeNull();
    expect(source.name).toBeNull();
    expect(source.slug).toBeNull();
    expect(source.externalUrl).toBeNull();
    expect(target.id).toBeNull();
    expect(target.type).toBeNull();
  });

  it("shapes null for null id/type/subtype/name/slug/externalUrl within endpoints", async () => {
    const get = vi.fn().mockResolvedValue([
      {
        id: "link-3",
        linkType: LinkType.Produces,
        createdAt: "2026-01-01T00:00:00.000Z",
        source: {
          id: null,
          type: null,
          subtype: null,
          name: null,
          slug: null,
          externalUrl: null,
        },
        target: {
          id: null,
          type: null,
          subtype: null,
          name: null,
          slug: null,
          externalUrl: null,
        },
      },
    ]);
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ artifactId: "PRD-1" })
    ) as { items: unknown[] };

    const item = payload.items[0] as Record<string, unknown>;
    const source = item.source as Record<string, unknown>;
    expect(source.id).toBeNull();
    expect(source.name).toBeNull();
    expect(source.externalUrl).toBeNull();
  });
});

/**
 * ISS-10102. `/artifact-links/resolved` is bounded per response now, so this
 * tool FOLLOWS the endpoint's cursor internally rather than exposing it. Its own
 * `limit` / `offset` / `total` / `hasMore` contract — which external MCP clients
 * already consume — is deliberately unchanged, which only stays true if the walk
 * actually reaches the last page.
 */
describe("list-artifact-links MCP tool — cursor following (ISS-10102)", () => {
  function linkWithId(id: string) {
    return { ...FULL_LINK, id };
  }

  it("reassembles every page into one honest total", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        items: [linkWithId("a"), linkWithId("b")],
        nextCursor: "2",
      })
      .mockResolvedValueOnce({ items: [linkWithId("c")], nextCursor: "4" })
      .mockResolvedValueOnce({ items: [linkWithId("d")] });
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ artifactId: "PRD-1", mode: LinkQueryMode.Tree })
    ) as { items: { id: string }[]; total: number; hasMore: boolean };

    expect(get).toHaveBeenCalledTimes(3);
    expect(payload.items.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    // The number this tool reports is still a count of what MATCHED, not of
    // what one response happened to carry.
    expect(payload.total).toBe(4);
    expect(payload.hasMore).toBe(false);
  });

  it("echoes each cursor back on the next request", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        items: [linkWithId("a")],
        nextCursor: "1000",
        snapshotId: "00000000-0000-4000-8000-000000000001",
      })
      .mockResolvedValueOnce({ items: [linkWithId("b")] });
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    await handler({ artifactId: "PRD-1" });

    const [, first] = get.mock.calls[0] as [string, Record<string, string>];
    const [, second] = get.mock.calls[1] as [string, Record<string, string>];
    expect(first).not.toHaveProperty("cursor");
    expect(second.cursor).toBe("1000");
    expect(first).not.toHaveProperty("snapshotId");
    expect(second.snapshotId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("stops on an absent cursor rather than on a short page", async () => {
    // A page that is neither full nor final: only the ABSENT cursor ends the
    // walk, so a reader that stopped on `items.length` would lose page two.
    const get = vi
      .fn()
      .mockResolvedValueOnce({ items: [linkWithId("a")], nextCursor: "1" })
      .mockResolvedValueOnce({ items: [linkWithId("b")] });
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ artifactId: "PRD-1" })
    ) as { total: number };

    expect(get).toHaveBeenCalledTimes(2);
    expect(payload.total).toBe(2);
  });

  it("terminates instead of looping when a cursor fails to advance", async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ items: [linkWithId("a")], nextCursor: "7" });
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ artifactId: "PRD-1" })
    ) as { total: number };

    // Two reads: the first learns cursor "7", the second is answered with the
    // same "7" and stops. A tool that trusted the cursor would never return.
    expect(get).toHaveBeenCalledTimes(2);
    expect(payload.total).toBe(2);
  });

  it("surfaces a page that is neither an envelope nor an array", async () => {
    // Defaulting a missing `items` to `[]` ends the walk on page one and
    // reports `total: 0` — a successful empty answer where the contract
    // actually failed (#7368 review, whitlockk). Two shapes are legal here; a
    // third is a bug, and an MCP error is the only answer that says so.
    const get = vi.fn().mockResolvedValue({ links: [FULL_LINK] });
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    const result = await handler({ artifactId: "PRD-1" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("/artifact-links/resolved");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("degrades to one page when the api predates ISS-10102", async () => {
    // Deploy skew: an older `apps/api` ignores `paginated` and answers with the
    // bare array it always did. Reading `.items` off that yields `undefined`,
    // and spreading it throws — so the array is treated as a terminal page.
    const get = vi.fn().mockResolvedValue([FULL_LINK]);
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ artifactId: "PRD-1" })
    ) as { total: number; items: unknown[] };

    expect(get).toHaveBeenCalledTimes(1);
    expect(payload.total).toBe(1);
    expect(payload.items).toHaveLength(1);
  });
});

/**
 * ISS-10840. The limits are written as literals, not imported, so widening the
 * tool's bound reds this suite.
 */
describe("list-artifact-links MCP tool — tree depth bound (ISS-10840)", () => {
  it("refuses the previously-permitted extreme through the real MCP schema", async () => {
    const get = vi.fn().mockResolvedValue([]);

    const result = await callThroughServer(
      {
        artifactId: "PRD-1",
        mode: LinkQueryMode.Tree,
        direction: LinkDirection.Both,
        maxDepth: 50,
      },
      get
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("maxDepth");
    expect(result.text).toMatch(AT_MOST_10);
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses a both-direction tree at the deepest depth the schema admits", async () => {
    const get = vi.fn().mockResolvedValue([]);

    const result = await callThroughServer(
      {
        artifactId: "PRD-1",
        mode: LinkQueryMode.Tree,
        direction: LinkDirection.Both,
        maxDepth: 10,
      },
      get
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("maxDepth up to 2 (received 10)");
    expect(result.text).toContain("(maxDepth up to 10)");
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ["direction both", { direction: LinkDirection.Both }],
    ["direction omitted", {}],
  ])(
    "refuses a tree past depth 2 with %s, naming the limit",
    async (_label, directionArg) => {
      const get = vi.fn().mockResolvedValue([]);
      const handler = createToolHarness(registerListArtifactLinks, {
        get,
      } as unknown as ApiClient);

      const result = await handler({
        artifactId: "PRD-1",
        mode: LinkQueryMode.Tree,
        maxDepth: 3,
        ...directionArg,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("maxDepth up to 2");
      expect(get).not.toHaveBeenCalled();
    }
  );

  it("forwards a both-direction tree at the limit", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    await handler({
      artifactId: "PRD-1",
      mode: LinkQueryMode.Tree,
      direction: LinkDirection.Both,
      maxDepth: 2,
    });

    const [, query] = get.mock.calls[0] as [string, Record<string, string>];
    expect(query.maxDepth).toBe("2");
  });

  it.each([LinkDirection.Source, LinkDirection.Target])(
    "keeps depth 10 for a %s lineage walk",
    async (direction) => {
      const get = vi.fn().mockResolvedValue([]);
      const handler = createToolHarness(registerListArtifactLinks, {
        get,
      } as unknown as ApiClient);

      const result = await handler({
        artifactId: "PRD-1",
        mode: LinkQueryMode.Tree,
        direction,
        maxDepth: 10,
      });

      expect(result.isError).toBeUndefined();
      const [, query] = get.mock.calls[0] as [string, Record<string, string>];
      expect(query).toMatchObject({ direction, maxDepth: "10" });
    }
  );

  it("sends the both-direction limit when a tree call omits maxDepth", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const handler = createToolHarness(registerListArtifactLinks, {
      get,
    } as unknown as ApiClient);

    await handler({ artifactId: "PRD-1", mode: LinkQueryMode.Tree });
    await handler({
      artifactId: "PRD-1",
      mode: LinkQueryMode.Tree,
      direction: LinkDirection.Target,
    });

    const [, bothQuery] = get.mock.calls[0] as [string, Record<string, string>];
    const [, targetQuery] = get.mock.calls[1] as [
      string,
      Record<string, string>,
    ];
    expect(bothQuery.maxDepth).toBe("2");
    expect(targetQuery).not.toHaveProperty("maxDepth");
  });
});

const AT_MOST_10 = /<=\s?10\b/;

function callThroughServer(
  args: Record<string, unknown>,
  get: ReturnType<typeof vi.fn>
) {
  return callToolThroughServer(
    registerListArtifactLinks,
    { get } as unknown as ApiClient,
    { name: "list-artifact-links", arguments: args }
  );
}
