import { describe, expect, it } from "vitest";
import type { DocsHelpSearchHit } from "../../../../shared/docs-help-contract";
import { docsHitsToSurfaceResults } from "../docs-search-surface-results";

/**
 * ISS-9414, marisolashgrove review. This mapper is the DESKTOP seam the PR's
 * both-host argument leans on, and it had no coverage at all: the both-host
 * contract mocks it on each shell, and the surface suites hand
 * `SearchSurfaceResult` fixtures in directly. So `key`, `kindLabel` and
 * `destination` were asserted nowhere.
 */

function hit(overrides: Partial<DocsHelpSearchHit> = {}): DocsHelpSearchHit {
  return {
    path: "guides/loops",
    title: "Loops",
    matchField: "body",
    score: 1,
    excerpt: "a loop is",
    ...overrides,
  } as DocsHelpSearchHit;
}

describe("docsHitsToSurfaceResults", () => {
  it("carries the matched field through as the row's kind label", () => {
    expect(
      docsHitsToSurfaceResults([
        hit({ matchField: "title" }),
        hit({ matchField: "heading" }),
        hit({ matchField: "body" }),
        hit({ matchField: "group" }),
      ]).map((result) => result.kindLabel)
    ).toEqual(["Title", "Section", "Body", "Group"]);
  });

  /**
   * One page can match twice under different anchors, so the heading has to
   * reach BOTH the React key and the href — a key that dropped it would collapse
   * two rows into one, and an href that dropped it would land both on the page
   * top.
   */
  it("puts the heading slug in the key and the destination when present", () => {
    const [result] = docsHitsToSurfaceResults([
      hit({ headingSlug: "retries" }),
    ]);

    expect(result?.key).toBe("guides/loops#retries");
    const destination = new URL(result?.destination ?? "", "http://d");
    expect(destination.searchParams.get("page")).toBe("guides/loops");
    expect(destination.searchParams.get("heading")).toBe("retries");
  });

  it("omits the heading from the destination when the hit carries none", () => {
    const [result] = docsHitsToSurfaceResults([hit()]);

    expect(result?.key).toBe("guides/loops#");
    const destination = new URL(result?.destination ?? "", "http://d");
    expect(destination.searchParams.get("page")).toBe("guides/loops");
    expect(destination.searchParams.has("heading")).toBe(false);
  });

  /** The local index holds no updated-at, so inventing a `meta` is barred. */
  it("reports no meta and falls back to an empty snippet", () => {
    const [result] = docsHitsToSurfaceResults([
      hit({ excerpt: undefined as unknown as string }),
    ]);

    expect(result?.meta).toBeUndefined();
    expect(result?.snippet).toBe("");
  });
});
