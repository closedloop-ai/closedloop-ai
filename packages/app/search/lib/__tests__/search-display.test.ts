import { ArtifactType } from "@repo/api/src/types/artifact";
import type { SearchHit } from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { describe, expect, it } from "vitest";
import {
  orgScopedDeepLink,
  parseSnippetSegments,
  SEARCH_ENTITY_TYPE_LABELS,
  searchHitOrgRelativeRoute,
} from "../search-display";

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    entityType: SearchEntityType.Document,
    entityId: "e1",
    title: "T",
    snippet: "s",
    rank: 0.5,
    updatedAt: new Date("2026-01-01"),
    deepLink: "/documents/e1",
    ...over,
  };
}

describe("parseSnippetSegments", () => {
  it("splits a ts_headline snippet into plain and highlighted segments", () => {
    const segments = parseSnippetSegments("run the <b>alpha</b> loop now");

    expect(
      segments.map((s) => ({ text: s.text, highlighted: s.highlighted }))
    ).toEqual([
      { text: "run the ", highlighted: false },
      { text: "alpha", highlighted: true },
      { text: " loop now", highlighted: false },
    ]);
  });

  it("handles multiple matches", () => {
    const segments = parseSnippetSegments("<b>a</b> and <b>b</b>");

    expect(segments.filter((s) => s.highlighted).map((s) => s.text)).toEqual([
      "a",
      "b",
    ]);
  });

  it("gives each segment a stable, unique key", () => {
    const segments = parseSnippetSegments("<b>a</b> and <b>b</b>");
    const keys = segments.map((s) => s.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("degrades an unbalanced open marker to plain text", () => {
    const segments = parseSnippetSegments("open <b>never closes");

    expect(segments).toEqual([
      { key: "0:p", text: "open <b>never closes", highlighted: false },
    ]);
  });

  it("returns a single plain segment when there are no markers", () => {
    const segments = parseSnippetSegments("plain text");

    expect(segments).toEqual([
      { key: "0:p", text: "plain text", highlighted: false },
    ]);
  });

  it("drops empty segments between adjacent markers", () => {
    const segments = parseSnippetSegments("<b>a</b><b>b</b>");

    expect(segments.map((s) => s.text)).toEqual(["a", "b"]);
  });
});

describe("orgScopedDeepLink", () => {
  it("prefixes the org slug onto an org-relative fragment", () => {
    expect(orgScopedDeepLink("acme", "/documents/doc-1")).toBe(
      "/acme/documents/doc-1"
    );
  });
});

describe("searchHitOrgRelativeRoute", () => {
  it("builds a document route from type + slug", () => {
    expect(
      searchHitOrgRelativeRoute(
        hit({
          entityType: SearchEntityType.Document,
          entitySubtype: "PRD",
          slug: "my-prd",
        })
      )
    ).toBe("/prds/my-prd");
  });

  it("builds a team-scoped project route", () => {
    expect(
      searchHitOrgRelativeRoute(
        hit({
          entityType: SearchEntityType.Project,
          entityId: "p1",
          teamId: "t1",
        })
      )
    ).toBe("/teams/t1/projects/p1");
  });

  it("builds a loop route by id", () => {
    expect(
      searchHitOrgRelativeRoute(
        hit({ entityType: SearchEntityType.Loop, entityId: "l1" })
      )
    ).toBe("/loops/l1");
  });

  it("returns null (non-link) when a document lacks the slug/subtype to route", () => {
    // Missing slug.
    expect(
      searchHitOrgRelativeRoute(
        hit({ entityType: SearchEntityType.Document, entitySubtype: "PRD" })
      )
    ).toBeNull();
    // Non-routable subtype (Template has no route prefix).
    expect(
      searchHitOrgRelativeRoute(
        hit({
          entityType: SearchEntityType.Document,
          entitySubtype: "TEMPLATE",
          slug: "t",
        })
      )
    ).toBeNull();
  });

  it("returns null (non-link) when a project lacks its owning team", () => {
    expect(
      searchHitOrgRelativeRoute(
        hit({ entityType: SearchEntityType.Project, entityId: "p1" })
      )
    ).toBeNull();
  });

  it("builds a branch route by id and a PR route to its branch anchor (FEA-3930)", () => {
    expect(
      searchHitOrgRelativeRoute(
        hit({ entityType: SearchEntityType.Branch, entityId: "b1" })
      )
    ).toBe("/branches/b1");
    expect(
      searchHitOrgRelativeRoute(
        hit({
          entityType: SearchEntityType.PullRequest,
          entityId: "pr1",
          anchorEntityId: "b7",
        })
      )
    ).toBe("/branches/b7");
  });

  it("routes a comment to its anchored session/branch and non-links otherwise (FEA-3930)", () => {
    expect(
      searchHitOrgRelativeRoute(
        hit({
          entityType: SearchEntityType.Comment,
          entityId: "c1",
          anchorEntityId: "s1",
          entitySubtype: ArtifactType.Session,
        })
      )
    ).toBe("/sessions/s1");
    // No anchor → non-link (graceful).
    expect(
      searchHitOrgRelativeRoute(hit({ entityType: SearchEntityType.Comment }))
    ).toBeNull();
  });
});

describe("SEARCH_ENTITY_TYPE_LABELS", () => {
  it("labels every Phase-1 corpus type", () => {
    expect(SEARCH_ENTITY_TYPE_LABELS[SearchEntityType.Document]).toBe(
      "Document"
    );
    expect(SEARCH_ENTITY_TYPE_LABELS[SearchEntityType.Project]).toBe("Project");
    expect(SEARCH_ENTITY_TYPE_LABELS[SearchEntityType.Loop]).toBe("Loop");
  });

  it("labels an agent_component as Component (FEA-4011)", () => {
    expect(SEARCH_ENTITY_TYPE_LABELS[SearchEntityType.AgentComponent]).toBe(
      "Component"
    );
  });
});

describe("searchHitOrgRelativeRoute — agent_component (FEA-4011)", () => {
  it("routes a component to /agents/<slug> and non-links when the slug is absent", () => {
    // The `${kind}::${key}` slug is URL-encoded so a key with `/`, `?`, or `#`
    // stays one `[slug]` segment (the `::` separator encodes to `%3A%3A`, which
    // Next.js decodes back on the route). See the encode-slug review thread.
    expect(
      searchHitOrgRelativeRoute(
        hit({
          entityType: SearchEntityType.AgentComponent,
          entityId: "ac1",
          slug: "skill::design-review",
        })
      )
    ).toBe("/agents/skill%3A%3Adesign-review");
    expect(
      searchHitOrgRelativeRoute(
        hit({ entityType: SearchEntityType.AgentComponent, entityId: "ac1" })
      )
    ).toBeNull();
  });
});
