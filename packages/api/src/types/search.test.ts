import { describe, expect, it } from "vitest";
import { ArtifactType } from "./artifact";
import { DOCUMENT_ROUTE_PREFIX, DocumentType } from "./document.ts";
import {
  boundSearchText,
  type SearchHit,
  SearchMode,
  searchHitDeepLink,
  searchHitRoute,
  searchHitSchema,
  unifiedSearchResponseSchema,
} from "./search";
import { isSupportedSearchType, SearchEntityType } from "./search-entity-kind";

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

describe("searchHitRoute", () => {
  it("builds a document route from type + slug", () => {
    expect(
      searchHitRoute(
        hit({
          entityType: SearchEntityType.Document,
          entitySubtype: "PRD",
          slug: "my-prd",
        })
      )
    ).toBe(`/${DOCUMENT_ROUTE_PREFIX}/my-prd`);
    expect(
      searchHitRoute(
        hit({
          entityType: SearchEntityType.Document,
          entitySubtype: "FEATURE",
          slug: "f",
        })
      )
    ).toBe(`/${DOCUMENT_ROUTE_PREFIX}/f`);
  });

  it("builds a team-scoped project route and an id-keyed loop route", () => {
    expect(
      searchHitRoute(
        hit({
          entityType: SearchEntityType.Project,
          entityId: "p1",
          teamId: "t1",
        })
      )
    ).toBe("/teams/t1/projects/p1");
    expect(
      searchHitRoute(hit({ entityType: SearchEntityType.Loop, entityId: "l1" }))
    ).toBe("/loops/l1");
  });

  it("builds an id-keyed session route for an agent_session hit (FEA-3930)", () => {
    expect(
      searchHitRoute(
        hit({ entityType: SearchEntityType.AgentSession, entityId: "sess-1" })
      )
    ).toBe("/sessions/sess-1");
  });

  it("returns null when a document is missing its slug", () => {
    expect(
      searchHitRoute(
        hit({ entityType: SearchEntityType.Document, entitySubtype: "PRD" })
      )
    ).toBeNull();
  });

  it("returns null for a template, which has no detail route", () => {
    expect(
      searchHitRoute(
        hit({
          entityType: SearchEntityType.Document,
          entitySubtype: DocumentType.Template,
          slug: "t",
        })
      )
    ).toBeNull();
  });

  it("returns null when a project is missing its owning team", () => {
    expect(
      searchHitRoute(
        hit({ entityType: SearchEntityType.Project, entityId: "p1" })
      )
    ).toBeNull();
  });

  it("builds an id-keyed branch route (FEA-3930)", () => {
    expect(
      searchHitRoute(
        hit({ entityType: SearchEntityType.Branch, entityId: "branch-1" })
      )
    ).toBe("/branches/branch-1");
  });

  it("routes a pull_request to its owning branch anchor (FEA-3930)", () => {
    expect(
      searchHitRoute(
        hit({
          entityType: SearchEntityType.PullRequest,
          entityId: "pr-1",
          anchorEntityId: "branch-7",
        })
      )
    ).toBe("/branches/branch-7");
    // Missing anchor → non-link (graceful), never a bare-id 404.
    expect(
      searchHitRoute(hit({ entityType: SearchEntityType.PullRequest }))
    ).toBeNull();
  });

  it("routes a session-anchored comment to the session it lives on (FEA-3930)", () => {
    expect(
      searchHitRoute(
        hit({
          entityType: SearchEntityType.Comment,
          entityId: "c1",
          anchorEntityId: "sess-1",
          entitySubtype: ArtifactType.Session,
        })
      )
    ).toBe("/sessions/sess-1");
  });

  it("routes a branch-anchored comment to the branch's trace-comments rail (FEA-3930)", () => {
    expect(
      searchHitRoute(
        hit({
          entityType: SearchEntityType.Comment,
          entityId: "c2",
          anchorEntityId: "branch-2",
          entitySubtype: ArtifactType.Branch,
        })
      )
    ).toBe("/branches/branch-2?tab=sessions-timeline");
  });

  it("builds a slug-keyed /agents route for an agent_component hit, non-link when slug absent (FEA-4011)", () => {
    // The slug is the org-identity `${kind}::${normalizedKey}` handle and is
    // encoded so a key carrying `/`, `?`, or `#` stays a single `[slug]`
    // segment (the `::` separator encodes to `%3A%3A`; Next.js decodes it back
    // on the route). See the encode-slug review thread on this route.
    expect(
      searchHitRoute(
        hit({
          entityType: SearchEntityType.AgentComponent,
          entityId: "ac-1",
          slug: "skill::design-review",
        })
      )
    ).toBe("/agents/skill%3A%3Adesign-review");
    // A key carrying a URL-significant character stays one path segment.
    expect(
      searchHitRoute(
        hit({
          entityType: SearchEntityType.AgentComponent,
          entityId: "ac-2",
          slug: "skill::a/b?c#d",
        })
      )
    ).toBe(`/agents/${encodeURIComponent("skill::a/b?c#d")}`);
    // Missing slug → non-link (graceful), never a bare-id 404.
    expect(
      searchHitRoute(
        hit({ entityType: SearchEntityType.AgentComponent, entityId: "ac-1" })
      )
    ).toBeNull();
  });

  it("routes a document-anchored comment to its document by the document's slug", () => {
    const documentComment = (slug: string) =>
      hit({
        entityType: SearchEntityType.Comment,
        entityId: "c3",
        anchorEntityId: "doc-1",
        entitySubtype: ArtifactType.Document,
        slug,
      });

    expect(searchHitRoute(documentComment("PRD-42"))).toBe(
      `/${DOCUMENT_ROUTE_PREFIX}/PRD-42`
    );
    expect(searchHitRoute(documentComment("FEA-7"))).toBe(
      `/${DOCUMENT_ROUTE_PREFIX}/FEA-7`
    );
    expect(searchHitRoute(documentComment("not-a-typed-slug"))).toBeNull();
  });

  it("returns null for a comment missing its anchor, a document-anchored one without the document's slug, or an unknown anchor type (FEA-3930)", () => {
    // No anchor at all.
    expect(
      searchHitRoute(hit({ entityType: SearchEntityType.Comment }))
    ).toBeNull();
    // A document anchor routes by the document's slug, absent here.
    expect(
      searchHitRoute(
        hit({
          entityType: SearchEntityType.Comment,
          anchorEntityId: "doc-1",
          entitySubtype: ArtifactType.Document,
        })
      )
    ).toBeNull();
    expect(
      searchHitRoute(
        hit({
          entityType: SearchEntityType.Comment,
          anchorEntityId: "x-1",
          entitySubtype: "NOT_AN_ARTIFACT_TYPE",
          slug: "PRD-42",
        })
      )
    ).toBeNull();
  });

  it("returns null for a document hit that carries no entitySubtype at all", () => {
    expect(
      searchHitRoute(
        hit({ entityType: SearchEntityType.Document, slug: "has-a-slug" })
      )
    ).toBeNull();
  });

  it("returns the raw entityType value for a version-skewed type outside the corpus", () => {
    // pins current behavior; looks odd because the exhaustive `never` guard
    // is compile-time only — at runtime this returns the unmatched value
    // verbatim instead of falling back to a safe non-link result.
    const unknownType = "future_entity_kind" as SearchEntityType;
    expect(searchHitRoute(hit({ entityType: unknownType }))).toBe(
      "future_entity_kind"
    );
  });
});

describe("searchHitDeepLink", () => {
  it("builds id-keyed deep links for document, project, loop, agent_session, and branch hits", () => {
    expect(searchHitDeepLink(SearchEntityType.Document, "d1")).toBe(
      "/documents/d1"
    );
    expect(searchHitDeepLink(SearchEntityType.Project, "p1")).toBe(
      "/projects/p1"
    );
    expect(searchHitDeepLink(SearchEntityType.Loop, "l1")).toBe("/loops/l1");
    expect(searchHitDeepLink(SearchEntityType.AgentSession, "s1")).toBe(
      "/sessions/s1"
    );
    expect(searchHitDeepLink(SearchEntityType.Branch, "b1")).toBe(
      "/branches/b1"
    );
  });

  it("falls back to the global-search locator for comment, pull_request, and agent_component hits", () => {
    for (const entityType of [
      SearchEntityType.Comment,
      SearchEntityType.PullRequest,
      SearchEntityType.AgentComponent,
    ]) {
      expect(searchHitDeepLink(entityType, "x1")).toBe("/search?entity=x1");
    }
  });

  it("returns the raw entityType value for a version-skewed type outside the corpus", () => {
    // pins current behavior; same never-guard caveat as searchHitRoute's
    // default arm above — this locator returns the unmatched value verbatim.
    const unknownType = "future_entity_kind" as SearchEntityType;
    expect(searchHitDeepLink(unknownType, "x1")).toBe("future_entity_kind");
  });
});

describe("boundSearchText", () => {
  it("returns null for a null source", () => {
    expect(boundSearchText(null, 10)).toBeNull();
  });

  it("returns null when the source trims to an empty string", () => {
    expect(boundSearchText("   ", 10)).toBeNull();
  });

  it("returns the trimmed value when it fits within max", () => {
    expect(boundSearchText("  hello  ", 10)).toBe("hello");
  });

  it("truncates the trimmed value to max when it exceeds the bound", () => {
    expect(boundSearchText("hello world", 5)).toBe("hello");
  });
});

describe("isSupportedSearchType (queryable types[] facet)", () => {
  it("accepts the comment/pull_request/branch corpus values (FEA-3930)", () => {
    expect(isSupportedSearchType(SearchEntityType.Comment)).toBe(true);
    expect(isSupportedSearchType(SearchEntityType.PullRequest)).toBe(true);
    expect(isSupportedSearchType(SearchEntityType.Branch)).toBe(true);
  });

  it("still accepts the earlier corpus values and rejects unknowns", () => {
    expect(isSupportedSearchType(SearchEntityType.Document)).toBe(true);
    expect(isSupportedSearchType(SearchEntityType.AgentSession)).toBe(true);
    expect(isSupportedSearchType("not-a-type")).toBe(false);
  });

  it("accepts the agent_component corpus value (FEA-4011)", () => {
    expect(isSupportedSearchType(SearchEntityType.AgentComponent)).toBe(true);
  });
});

describe("searchHitSchema route fields", () => {
  it("parses a hit carrying the optional route fields", () => {
    const parsed = searchHitSchema.parse({
      entityType: SearchEntityType.Document,
      entityId: "d1",
      title: "T",
      snippet: "s",
      rank: 0.5,
      updatedAt: "2026-01-01T00:00:00.000Z",
      deepLink: "/documents/d1",
      slug: "d",
      entitySubtype: "PRD",
      teamId: "t1",
    });
    expect(parsed.slug).toBe("d");
    expect(parsed.entitySubtype).toBe("PRD");
    expect(parsed.teamId).toBe("t1");
    expect(parsed.updatedAt).toBeInstanceOf(Date);
  });

  it("parses a version-skewed hit that omits the route fields (older API deploy)", () => {
    const parsed = searchHitSchema.parse({
      entityType: SearchEntityType.Loop,
      entityId: "l1",
      title: "T",
      snippet: "s",
      rank: 0.5,
      updatedAt: "2026-01-01T00:00:00.000Z",
      deepLink: "/loops/l1",
    });
    expect(parsed.slug).toBeUndefined();
    expect(parsed.entitySubtype).toBeUndefined();
    expect(parsed.teamId).toBeUndefined();
  });
});

describe("unifiedSearchResponseSchema forward-compat (FEA-4011 version skew)", () => {
  function rawHit(over: Record<string, unknown>) {
    return {
      entityType: SearchEntityType.Document,
      entityId: "d1",
      title: "T",
      snippet: "s",
      rank: 0.5,
      updatedAt: "2026-01-01T00:00:00.000Z",
      deepLink: "/documents/d1",
      ...over,
    };
  }

  it("keeps known-type hits and drops a hit with an unknown corpus entityType", () => {
    const parsed = unifiedSearchResponseSchema.parse({
      query: "q",
      mode: SearchMode.Fulltext,
      nextCursor: null,
      results: [
        rawHit({ entityType: SearchEntityType.Document, entityId: "keep-1" }),
        // A NEWER API emits a corpus type this (older) bundle's enum lacks.
        rawHit({ entityType: "some_future_type", entityId: "drop-me" }),
        rawHit({ entityType: SearchEntityType.Loop, entityId: "keep-2" }),
      ],
    });
    // The unknown hit is dropped; the two known hits survive (an unknown type no
    // longer rejects the whole result set).
    expect(parsed.results.map((r) => r.entityId)).toEqual(["keep-1", "keep-2"]);
  });

  it("parses a response whose every hit is a known type without dropping any", () => {
    const parsed = unifiedSearchResponseSchema.parse({
      query: "q",
      mode: SearchMode.Fulltext,
      nextCursor: null,
      results: [
        rawHit({
          entityType: SearchEntityType.AgentComponent,
          entityId: "ac-1",
          slug: "skill::x",
        }),
      ],
    });
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]?.entityType).toBe(SearchEntityType.AgentComponent);
  });
});
