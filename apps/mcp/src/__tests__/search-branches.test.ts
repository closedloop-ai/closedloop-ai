import { SearchMode } from "@repo/api/src/types/search.js";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind.js";
import { describe, expect, it, vi } from "vitest";
import { registerSearch } from "../tools/search.js";
import { createUrlBuilder, WEBAPP_URL } from "../tools/tool-utils.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

const ORG_SLUG = "acme";
const ENTITY_ID = "019c2991-0bce-76bc-bc7e-a4750929f668";

type UnifiedPayload = {
  mode: string;
  query: string;
  resultCount: number;
  nextCursor: string | null;
  results: Array<{
    entityType: string | null;
    entityId: string | null;
    title: string | null;
    snippet: string | null;
    rank: number | null;
    updatedAt: string | null;
    webUrl: string | null;
  }>;
};

function makeHandler(response: unknown) {
  const get = vi.fn().mockResolvedValue(response);
  const handler = createToolHarness(
    registerSearch,
    { get } as never,
    createUrlBuilder(() => ORG_SLUG)
  );
  return { get, handler };
}

async function runUnified(hit: Record<string, unknown>) {
  const { handler } = makeHandler({
    mode: SearchMode.Fulltext,
    query: "auth",
    results: [hit],
  });
  return parseToolPayload(
    await handler({ q: "auth", mode: SearchMode.Fulltext })
  ) as UnifiedPayload;
}

describe("search unified hit routing fallbacks", () => {
  it("falls back to the UUID deep link, org-prefixed, when a document hit has no Phase-2 route and no server deepLink", async () => {
    // No entitySubtype/slug means searchHitRoute returns null; no deepLink
    // means the last resort is the shared UUID-only locator.
    const payload = await runUnified({
      entityType: SearchEntityType.Document,
      entityId: ENTITY_ID,
    });

    expect(payload.results[0]).toEqual({
      entityType: SearchEntityType.Document,
      entityId: ENTITY_ID,
      title: null,
      snippet: null,
      rank: null,
      updatedAt: null,
      webUrl: `${WEBAPP_URL}/${ORG_SLUG}/documents/${ENTITY_ID}`,
    });
  });

  it("prefers the server deepLink over the UUID locator when the Phase-2 route cannot be built", async () => {
    const payload = await runUnified({
      entityType: SearchEntityType.Document,
      entityId: ENTITY_ID,
      deepLink: "/server/provided",
    });

    expect(payload.results[0]?.webUrl).toBe(
      `${WEBAPP_URL}/${ORG_SLUG}/server/provided`
    );
  });

  it("returns a null webUrl for an entity type outside the Phase-1 corpus with no deepLink", async () => {
    const payload = await runUnified({
      entityType: "not-a-search-type",
      entityId: ENTITY_ID,
    });

    expect(payload.results[0]?.entityType).toBe("not-a-search-type");
    expect(payload.results[0]?.webUrl).toBeNull();
  });

  it("returns a null webUrl for a Phase-1 type whose entityId is missing and has no deepLink", async () => {
    const payload = await runUnified({
      entityType: SearchEntityType.AgentSession,
    });

    expect(payload.results[0]?.entityId).toBeNull();
    expect(payload.results[0]?.webUrl).toBeNull();
  });

  it("still uses a server deepLink for an unknown entity type", async () => {
    const payload = await runUnified({
      entityType: "not-a-search-type",
      entityId: ENTITY_ID,
      deepLink: "/legacy/link",
    });

    expect(payload.results[0]?.webUrl).toBe(
      `${WEBAPP_URL}/${ORG_SLUG}/legacy/link`
    );
  });
});

describe("search unified hit Phase-2 routes", () => {
  it.each([
    {
      name: "a project hit routes through its team",
      hit: {
        entityType: SearchEntityType.Project,
        entityId: ENTITY_ID,
        teamId: "team-1",
      },
      path: `/teams/team-1/projects/${ENTITY_ID}`,
    },
    {
      name: "a pull-request hit routes to its anchor branch",
      hit: {
        entityType: SearchEntityType.PullRequest,
        entityId: ENTITY_ID,
        anchorEntityId: "branch-1",
      },
      path: "/branches/branch-1",
    },
  ])("$name", async ({ hit, path }) => {
    const payload = await runUnified({ ...hit, deepLink: "/legacy" });

    expect(payload.results[0]?.webUrl).toBe(`${WEBAPP_URL}/${ORG_SLUG}${path}`);
  });
});

describe("search response envelope fallbacks", () => {
  it("echoes the requested mode and q and reports zero results when the unified response omits them", async () => {
    const { get, handler } = makeHandler({});

    const payload = parseToolPayload(
      await handler({ q: "auth", mode: SearchMode.Prefix })
    ) as UnifiedPayload;

    // Strict: an absent limit/cursor must not be sent as an undefined key.
    expect(get.mock.calls[0]?.[1]).toStrictEqual({
      q: "auth",
      mode: SearchMode.Prefix,
    });
    expect(payload).toEqual({
      mode: SearchMode.Prefix,
      query: "auth",
      resultCount: 0,
      nextCursor: null,
      results: [],
    });
  });

  it("echoes q when the legacy response omits query", async () => {
    const { handler } = makeHandler({ documents: [], projects: [] });

    const payload = parseToolPayload(await handler({ q: "plain" })) as {
      query: string;
      documentCount: number;
    };

    expect(payload.query).toBe("plain");
    expect(payload.documentCount).toBe(0);
  });
});
