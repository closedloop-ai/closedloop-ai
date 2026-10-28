import { DocumentStatus } from "@repo/api/src/types/document";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it } from "vitest";
import type { DocumentRowItem } from "../../components/table/document-row";
import type { DisplayGroup } from "../../components/table/document-tree";
import { toRowItem } from "../../components/table/document-tree";
import {
  buildDocumentGridGroups,
  resolveSectionPopulation,
} from "../documents-grid-groups";
import { GroupByMode } from "../group-by";

/**
 * ISS-9335 — the board's sections as shared-grid bands.
 *
 * The two facts worth pinning are the ones a reader of the rendered board would
 * be misled by if they broke: which BAND a nested artifact belongs to (its
 * root's, never its own), and what a band's count is allowed to claim.
 */

const ROOT = makeArtifact({ id: "root-a", status: DocumentStatus.InReview });
const CHILD = makeArtifact({ id: "child-a", status: DocumentStatus.Draft });

describe("resolveSectionPopulation", () => {
  it("defers to the band's own rows when no totals map was supplied", () => {
    expect(resolveSectionPopulation(undefined, "anything")).toBeUndefined();
  });

  it("answers from the totals map when it covers the section", () => {
    expect(resolveSectionPopulation(new Map([["draft", 9]]), "draft")).toBe(9);
  });

  it("answers 'no number' — not the page's own length — for a section it does not cover", () => {
    // `null` and `undefined` are different answers here and the difference is
    // the whole point: `undefined` would license the caller to publish the rows
    // it happens to hold as the section's population.
    expect(
      resolveSectionPopulation(new Map([["draft", 9]]), "review")
    ).toBeNull();
  });
});

describe("buildDocumentGridGroups", () => {
  const groups: DisplayGroup[] = [
    { children: [toRowItem(CHILD)], groupKey: ROOT.id, root: toRowItem(ROOT) },
  ];
  const input = {
    groups,
    groupBy: GroupByMode.Status,
    groupOptions: {},
    isGroupedView: true,
    flatItems: [],
  };

  it("keeps a descendant under its root rather than in its own status band", () => {
    // The child is DRAFT and the band is IN REVIEW. Root-only grouping means
    // the child has no band membership of its own — it rides its root.
    const bands = buildDocumentGridGroups(input);

    expect(bands).toHaveLength(1);
    expect(bands[0]?.items.map((item) => item.data.id)).toEqual([ROOT.id]);
    expect(bands[0]?.items[0]?.children?.map((c) => c.data.id)).toEqual([
      CHILD.id,
    ]);
  });

  it("declares no count when the caller is unpaged, so the grid derives one", () => {
    const bands = buildDocumentGridGroups(input);

    expect(bands[0]?.count).toBeUndefined();
  });

  it("carries the caller's population and its continued marker", () => {
    const bands = buildDocumentGridGroups({
      continuedSectionKeys: new Set([DocumentStatus.InReview]),
      ...input,
      sectionTotalsByKey: new Map([[DocumentStatus.InReview, 12]]),
    });

    expect(bands[0]?.count).toBe(12);
    expect(bands[0]?.isContinued).toBe(true);
  });

  it("declares an explicit no-count for a band the totals do not cover", () => {
    const bands = buildDocumentGridGroups({
      ...input,
      sectionTotalsByKey: new Map([["some-other-status", 12]]),
    });

    expect(bands[0]?.count).toBeNull();
  });

  it("does not attach a subtree a flat section never had", () => {
    const bands = buildDocumentGridGroups({
      groupBy: GroupByMode.Status,
      groupOptions: {},
      groups: [],
      isGroupedView: false,
      flatItems: [{ ...toRowItem(CHILD), children: [] }],
    });

    const item: DocumentRowItem | undefined = bands[0]?.items[0];
    expect(item?.children).toEqual([]);
  });
});
