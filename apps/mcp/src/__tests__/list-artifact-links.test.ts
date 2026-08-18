import {
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerListArtifactLinks } from "../tools/list-artifact-links.js";
import {
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
    expect(query).toEqual({ artifactId: "PRD-1" });
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
