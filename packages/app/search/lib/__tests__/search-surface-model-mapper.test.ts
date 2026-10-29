import { describe, expect, it } from "vitest";
import type { OfferedSearchHit } from "../search-display";
import { searchHitsToSurfaceResults } from "../search-surface-model";

/**
 * ISS-9414, marisolashgrove review. The WEB boundary mapper had no unit coverage:
 * the both-host contract mocks it, the surface suites take
 * `SearchSurfaceResult` fixtures directly, and the one thing pinning it was an
 * href assertion in `e2e/search-surface-v2.spec.ts` — which, per davetho's
 * route-mock finding, was not loading the page at all.
 */

function hit(overrides: Partial<OfferedSearchHit> = {}): OfferedSearchHit {
  return {
    entityType: "agent_session",
    entityId: "session-1",
    title: "A session",
    snippet: "matched <b>here</b>",
    rank: 0.5,
    updatedAt: new Date("2026-09-04T10:00:00.000Z").toISOString(),
    ...overrides,
  } as OfferedSearchHit;
}

describe("searchHitsToSurfaceResults", () => {
  it("keys a row by entity type and id, so two kinds cannot collide", () => {
    expect(
      searchHitsToSurfaceResults([
        hit({ entityType: "branch", entityId: "x" }),
        hit({ entityType: "agent_session", entityId: "x" }),
      ]).map((result) => result.key)
    ).toEqual(["branch:x", "agent_session:x"]);
  });

  it("builds the org-relative destination for an id-keyed hit", () => {
    const [result] = searchHitsToSurfaceResults([
      hit({ entityId: "session-7" }),
    ]);

    expect(result?.destination).toBe("/sessions/session-7");
  });

  /**
   * The null contract, which is what keeps a click off a 404: a document whose
   * subtype or slug is missing cannot be routed, and the row renders unlinked
   * rather than guessing.
   */
  it("reports a null destination for a document it cannot route", () => {
    const [result] = searchHitsToSurfaceResults([
      hit({ entityType: "document", entityId: "doc-1", slug: undefined }),
    ]);

    expect(result?.destination).toBeNull();
  });

  it("preserves the producer's order rather than re-ranking", () => {
    expect(
      searchHitsToSurfaceResults([
        hit({ entityId: "second", rank: 0.1 }),
        hit({ entityId: "first", rank: 0.9 }),
      ]).map((result) => result.key)
    ).toEqual(["agent_session:second", "agent_session:first"]);
  });

  it("carries the snippet verbatim, markers included, for typed parsing later", () => {
    const [result] = searchHitsToSurfaceResults([hit()]);

    expect(result?.snippet).toBe("matched <b>here</b>");
  });
});
