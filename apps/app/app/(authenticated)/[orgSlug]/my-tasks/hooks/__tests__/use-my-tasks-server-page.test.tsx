/**
 * ISS-10472: the board's binding to a server page.
 *
 * The load-bearing assertion here is the SECTION KEY. The wire carries each
 * section's root ids and no key, so `GroupSectionDescriptor.key` has exactly
 * one spelling — the renderer's — and this hook has to re-derive it from a row
 * the section holds. Get it wrong and nothing throws: a header renders against
 * a total belonging to a different section, or against none.
 */

import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import { IssueStatus } from "@repo/api/src/types/document";
import type {
  ProjectTreeResponse,
  TreeRootSection,
} from "@repo/api/src/types/project-tree";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { treeDocumentRows } from "../../lib/tree-document-rows";
import { useMyTasksServerPage } from "../use-my-tasks-server-page";

/** A status in no lifecycle vocabulary, so the two orderings key it apart. */
const OFF_VOCABULARY_STATUS = "SOMETHING_OFF_VOCABULARY";

const PROJECTS = new Map([
  ["p-a", { id: "p-a", name: "Project A", slug: "project-a" }],
]);

function artifact(id: string, status: string): Artifact {
  return {
    assignee: null,
    assigneeId: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    createdById: null,
    dueDate: null,
    externalUrl: null,
    id,
    name: `artifact ${id}`,
    organizationId: "org-1",
    priority: null,
    projectId: "p-a",
    slug: `slug-${id}`,
    sortOrder: null,
    status,
    subtype: ArtifactSubtype.Feature,
    type: ArtifactType.Document,
    updatedAt: new Date("2026-10-02T00:00:00.000Z"),
  };
}

function treeOf(artifacts: Artifact[]): ProjectTreeResponse {
  return {
    externalParents: [],
    nodes: artifacts.map((root) => ({ children: [], root })),
  };
}

type Overrides = Partial<Parameters<typeof useMyTasksServerPage>[0]>;

function renderPage(
  artifacts: Artifact[],
  sections: TreeRootSection[] | null,
  overrides: Overrides = {}
) {
  const treeData = treeOf(artifacts);
  const documents = treeDocumentRows(treeData, PROJECTS);
  const setPage = vi.fn();
  const result = renderHook(() =>
    useMyTasksServerPage({
      documents,
      groupBy: GroupByMode.Status,
      ordering: null,
      page: 0,
      pageSize: 50,
      rowOffset: null,
      rowsBefore: 0,
      sections,
      setPage,
      total: artifacts.length,
      totalPages: 1,
      treeData,
      ...overrides,
    })
  );
  return { result, setPage };
}

describe("useMyTasksServerPage", () => {
  it("keys a section's total by the key the renderer computes for its rows", () => {
    const rows = [
      artifact("a", IssueStatus.Todo),
      artifact("b", IssueStatus.Done),
    ];
    const { result } = renderPage(rows, [
      { continued: false, rootIds: ["a"], total: 7 },
      { continued: false, rootIds: ["b"], total: 3 },
    ]);

    // A status section keys on the status value itself, so a mismatch here is
    // visible rather than inferred.
    expect(
      result.result.current.sectionTotalsByKey?.get(IssueStatus.Todo)
    ).toBe(7);
    expect(
      result.result.current.sectionTotalsByKey?.get(IssueStatus.Done)
    ).toBe(3);
  });

  it("marks a continued section under that same key", () => {
    const { result } = renderPage(
      [artifact("a", IssueStatus.Todo)],
      [{ continued: true, rootIds: ["a"], total: 9 }]
    );

    expect(
      result.result.current.continuedSectionKeys?.has(IssueStatus.Todo)
    ).toBe(true);
  });

  it("reports NO section plan when the board is ungrouped", () => {
    // `undefined` is how a renderer is told it holds no section-aware plan and
    // must not print this page's subset as a section's population.
    const { result } = renderPage(
      [artifact("a", IssueStatus.Todo)],
      [{ continued: false, rootIds: ["a"], total: 7 }],
      { groupBy: GroupByMode.None }
    );

    expect(result.result.current.sectionTotalsByKey).toBeUndefined();
    expect(result.result.current.continuedSectionKeys).toBeUndefined();
  });

  it("reports no section plan when the response carried no sections", () => {
    const { result } = renderPage([artifact("a", IssueStatus.Todo)], null);

    expect(result.result.current.sectionTotalsByKey).toBeUndefined();
  });

  it("skips a section whose roots are not on this page", () => {
    // Attaching a total to a header the renderer will not draw states a
    // population for a section that is not there.
    const { result } = renderPage(
      [artifact("a", IssueStatus.Todo)],
      [
        { continued: false, rootIds: ["a"], total: 7 },
        { continued: false, rootIds: ["absent"], total: 4 },
      ]
    );

    expect(result.result.current.sectionTotalsByKey?.size).toBe(1);
  });

  it("anchors the range on rowsBefore, not on page times page size", () => {
    const rows = [
      artifact("a", IssueStatus.Todo),
      artifact("b", IssueStatus.Todo),
    ];
    const { result } = renderPage(
      rows,
      [{ continued: true, rootIds: ["a", "b"], total: 50 }],
      { page: 2, rowsBefore: 17, total: 50, totalPages: 5 }
    );

    // Variable-height pages: 17 rows really preceded this one, which no
    // arithmetic on page 2 would produce.
    expect(result.result.current.from).toBe(18);
    expect(result.result.current.to).toBe(19);
  });

  it("reports an empty range for an empty corpus", () => {
    const { result } = renderPage([], [], { total: 0 });

    expect(result.result.current.from).toBe(0);
  });

  it("clamps a page past the end of the plan", () => {
    const { setPage } = renderPage(
      [artifact("a", IssueStatus.Todo)],
      [{ continued: false, rootIds: ["a"], total: 1 }],
      { page: 9, totalPages: 3 }
    );

    expect(setPage).toHaveBeenCalledWith(2);
  });

  it("pages an UNGROUPED read past page 0, deriving the page count", () => {
    // A row-paged response carries {offset, limit, total} and NO totalPages,
    // and reading that as one page clamped every later page back to 0 — the
    // reported defect again, for anyone with grouping off (tamsinb, PR #9026).
    const { result, setPage } = renderPage(
      [artifact("a", IssueStatus.Todo)],
      null,
      {
        groupBy: GroupByMode.None,
        page: 3,
        pageSize: 50,
        rowOffset: 150,
        rowsBefore: null,
        total: 500,
        totalPages: null,
      }
    );

    expect(result.result.current.totalPages).toBe(10);
    expect(result.result.current.page).toBe(3);
    expect(setPage).not.toHaveBeenCalled();
    // And the range anchors on the response's own row offset, not on 1.
    expect(result.result.current.from).toBe(151);
  });

  it("clamps an ungrouped page past the derived end", () => {
    const { setPage } = renderPage([artifact("a", IssueStatus.Todo)], null, {
      groupBy: GroupByMode.None,
      page: 40,
      pageSize: 50,
      rowOffset: 0,
      rowsBefore: null,
      total: 120,
      totalPages: null,
    });

    expect(setPage).toHaveBeenCalledWith(2);
  });

  it("does NOT clamp while this page's own metadata is still loading", () => {
    // An uncached page changes the query key, so the read returns null and
    // every count is unknown; clamping against that sent the selection back to
    // page 0 before the page it names had a chance to arrive (whitlockk, PR #9026).
    const { setPage } = renderPage([], null, {
      page: 4,
      pageSize: null,
      rowOffset: null,
      rowsBefore: null,
      total: null,
      totalPages: null,
    });

    expect(setPage).not.toHaveBeenCalled();
  });

  it("still refuses a negative page with no metadata", () => {
    const { setPage } = renderPage([], null, {
      page: -2,
      pageSize: null,
      rowOffset: null,
      rowsBefore: null,
      total: null,
      totalPages: null,
    });

    expect(setPage).toHaveBeenCalledWith(0);
  });

  it("keys sections with the ordering the RESPONSE named, not the browser's", () => {
    // The browser's gates are unresolved under this harness, which resolves to
    // the DEFAULT (vocabulary) ordering; the response names root-first, whose
    // sections key on the retained status evidence rather than the raw value.
    // Keying on the browser's answer files a header's total under a key the
    // server did not partition on (tamsinb, PR #9026).
    const named = renderPage(
      [artifact("a", OFF_VOCABULARY_STATUS)],
      [{ continued: false, rootIds: ["a"], total: 4 }],
      { ordering: ArtifactSectionOrdering.RootFirst }
    );
    const vocabulary = renderPage(
      [artifact("a", OFF_VOCABULARY_STATUS)],
      [{ continued: false, rootIds: ["a"], total: 4 }],
      { ordering: ArtifactSectionOrdering.Vocabulary }
    );

    const namedKeys = [
      ...(named.result.result.current.sectionTotalsByKey?.keys() ?? []),
    ];
    const vocabularyKeys = [
      ...(vocabulary.result.result.current.sectionTotalsByKey?.keys() ?? []),
    ];
    expect(namedKeys).toHaveLength(1);
    expect(namedKeys).not.toEqual(vocabularyKeys);
  });

  it("returns to the first page when the grouping changes", () => {
    const treeData = treeOf([artifact("a", IssueStatus.Todo)]);
    const documents = treeDocumentRows(treeData, PROJECTS);
    const setPage = vi.fn();
    const props: Parameters<typeof useMyTasksServerPage>[0] = {
      documents,
      groupBy: GroupByMode.Status,
      ordering: null,
      page: 3,
      pageSize: 50,
      rowOffset: null,
      rowsBefore: 0,
      sections: [{ continued: false, rootIds: ["a"], total: 1 }],
      setPage,
      total: 1,
      totalPages: 9,
      treeData,
    };
    const { rerender } = renderHook(
      (next: typeof props) => useMyTasksServerPage(next),
      { initialProps: props }
    );
    setPage.mockClear();

    act(() => {
      rerender({ ...props, groupBy: GroupByMode.Priority });
    });

    expect(setPage).toHaveBeenCalledWith(0);
  });
});
