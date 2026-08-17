import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import {
  PROJECT_TREE_MAX_ROOT_LIMIT,
  TreeTruncationReason,
} from "@repo/api/src/types/project-tree";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { describe, expect, it } from "vitest";
import {
  buildProjectTreeReadOptions,
  isProjectArtifactTreeLoading,
  resolveProjectArtifactsEmptyTruncationNote,
  resolveProjectArtifactsPageNoun,
  resolveProjectArtifactsTruncationNote,
} from "../project-artifacts-pagination";

const PROJECT_ID = "11111111-1111-7111-8111-111111111111";

/** An exact "of N" phrasing, which the note must never use for a floor. */
const MATCHED_TOTAL_PATTERN = /\b(1,284|900)\b/;

const ALL_CATEGORIES: FilterCategory[] = [
  "all",
  "documents",
  "features",
  "plans",
  "branches",
];

function truncatedTree(
  anchorsIncluded: number,
  anchorsMatchedAtLeast: number
): Pick<ProjectTreeResponse, "truncation"> {
  return {
    truncation: {
      anchorsIncluded,
      anchorsMatchedAtLeast,
      reasons: [TreeTruncationReason.AnchorCap],
    },
  };
}

describe("resolveProjectArtifactsPageNoun (ISS-5307)", () => {
  it("gives each tab a noun that describes that tab's population", () => {
    expect(resolveProjectArtifactsPageNoun("all")).toBe("top-level artifacts");
    expect(resolveProjectArtifactsPageNoun("documents")).toBe("PRDs");
    expect(resolveProjectArtifactsPageNoun("features")).toBe("issues");
    expect(resolveProjectArtifactsPageNoun("plans")).toBe("plans");
    expect(resolveProjectArtifactsPageNoun("branches")).toBe("branches");
  });

  it("never falls back to the project-wide noun on a narrowed tab", () => {
    // A generic "artifacts" under Plans would read as a project total when it
    // is the plan count — the readout would describe the wrong population.
    for (const category of ALL_CATEGORIES.filter((c) => c !== "all")) {
      expect(resolveProjectArtifactsPageNoun(category)).not.toContain(
        "artifacts"
      );
    }
  });

  it("qualifies the All tab as TOP-LEVEL, because it pages root groups", () => {
    // That tab counts roots, and each root brings its subtree onto the page —
    // so a bare "artifacts" would be contradicted by the visible row count.
    expect(resolveProjectArtifactsPageNoun("all")).toContain("top-level");
  });
});

describe("resolveProjectArtifactsTruncationNote (ISS-5307)", () => {
  it("returns null for a complete read so no caveat is shown", () => {
    // An untruncated response omits `truncation` entirely — that absence is
    // the contract's claim of completeness, not an unknown.
    expect(resolveProjectArtifactsTruncationNote({})).toBeNull();
    expect(resolveProjectArtifactsTruncationNote(undefined)).toBeNull();
    expect(resolveProjectArtifactsTruncationNote(null)).toBeNull();
  });

  it("returns null when a truncation carries no reasons", () => {
    expect(
      resolveProjectArtifactsTruncationNote({
        truncation: {
          anchorsIncluded: 10,
          anchorsMatchedAtLeast: 10,
          reasons: [],
        },
      })
    ).toBeNull();
  });

  it("says what the count was counted from when the server bounded the read", () => {
    const note = resolveProjectArtifactsTruncationNote(
      truncatedTree(500, 1284)
    );

    expect(note).toBe(
      "Counted from the first 500 top-level artifacts in this project."
    );
  });

  it("states ONE number and never asserts a project size", () => {
    const note = resolveProjectArtifactsTruncationNote(truncatedTree(500, 900));

    // The readout above already carries three numbers; a caveat that adds two
    // more stops being read (ISS-4682). And `anchorsMatchedAtLeast` is a FLOOR
    // by contract — printing it here would assert a size nobody measured.
    expect(note).not.toMatch(MATCHED_TOTAL_PATTERN);
    expect(note).toContain("first 500");
  });
});

/**
 * wongk: the flag SHAPES this request, and PostHog resolves asynchronously.
 * Acting on an unresolved flag sends the unbounded read and then refetches
 * bounded — the enabled viewer pays, at first paint, the cost the bound exists
 * to remove. `isReady` is what makes it one request.
 */
describe("buildProjectTreeReadOptions — the flag decides the request shape", () => {
  it("holds the read until the flag has resolved", () => {
    const options = buildProjectTreeReadOptions(false, false, PROJECT_ID);

    expect(options?.enabled).toBe(false);
    // Unresolved reads as flag-OFF, so without the hold this would be the
    // unbounded request going out first.
    expect(options).not.toHaveProperty("filters");
  });

  it("bounds the read once the flag has resolved ON", () => {
    const options = buildProjectTreeReadOptions(true, true, PROJECT_ID);

    expect(options?.enabled).toBe(true);
    expect(options?.filters).toEqual({ limit: PROJECT_TREE_MAX_ROOT_LIMIT });
  });

  it("omits the bound entirely when the flag resolved OFF", () => {
    const options = buildProjectTreeReadOptions(false, true, PROJECT_ID);

    expect(options?.enabled).toBe(true);
    // `limit` participates in the cache key, so an explicit `undefined` would
    // move a flag-off viewer onto a different entry than they had before.
    expect(options).not.toHaveProperty("filters");
  });

  it("still refuses to issue the bounded read before the flag answers", () => {
    const options = buildProjectTreeReadOptions(true, false, PROJECT_ID);

    expect(options?.enabled).toBe(false);
  });
});

describe("isProjectArtifactTreeLoading — the flag gate is part of loading", () => {
  it("keeps the table loading while the flag is still resolving", () => {
    // The query is held on `enabled: false` here, so it reports NOT loading.
    // Reading that alone would paint "this project has no artifacts".
    expect(isProjectArtifactTreeLoading(false, false)).toBe(true);
  });

  it("reports loaded once the flag resolved and the read settled", () => {
    expect(isProjectArtifactTreeLoading(false, true)).toBe(false);
  });

  it("still reports loading while the read itself is in flight", () => {
    expect(isProjectArtifactTreeLoading(true, true)).toBe(true);
  });
});

/**
 * The caveat used to live only inside the footer, and the footer only renders
 * when the tab has rows — so a truncated project filtered down to zero matches
 * dropped it at the one moment it decides what the screen MEANS.
 */
describe("resolveProjectArtifactsEmptyTruncationNote — the caveat survives an empty tab", () => {
  it("explains the absence rather than a count that is not on screen", () => {
    const note = resolveProjectArtifactsEmptyTruncationNote(
      truncatedTree(500, 900)
    );

    expect(note).toContain("No matches in the first 500");
    // The footer's wording explains a number; with no rows there is no number,
    // so quoting "Counted from" here would describe nothing on the page.
    expect(note).not.toContain("Counted from");
  });

  it("quotes the SAME figure as the footer's note", () => {
    const tree = truncatedTree(500, 900);

    // Two wordings, one source: they must never disagree about how much was
    // read.
    expect(resolveProjectArtifactsEmptyTruncationNote(tree)).toContain("500");
    expect(resolveProjectArtifactsTruncationNote(tree)).toContain("500");
  });

  it("never asserts a project size it did not measure", () => {
    const note = resolveProjectArtifactsEmptyTruncationNote(
      truncatedTree(500, 900)
    );

    expect(note).not.toMatch(MATCHED_TOTAL_PATTERN);
  });

  it("says nothing on a complete read", () => {
    // An empty tab on a COMPLETE read really does mean "nothing matches", and a
    // caveat there would train people to ignore it.
    expect(resolveProjectArtifactsEmptyTruncationNote({})).toBeNull();
    expect(resolveProjectArtifactsEmptyTruncationNote(null)).toBeNull();
  });
});
