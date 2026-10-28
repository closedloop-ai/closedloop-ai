import {
  BOARD_SORT_PARITY_CASES,
  BOARD_SORT_PARITY_EPOCH,
  BOARD_SORT_PARITY_ROWS,
  type BoardSortParityCase,
  type BoardSortParityRow,
} from "@repo/api/src/project-artifact-board-sort-parity.test-fixtures";
import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import {
  ProjectArtifactBoardSort,
  ProjectArtifactBoardSortDirection,
} from "@repo/api/src/types/project-artifact-board-page";
import type {
  DetailedArtifact,
  ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import type { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { documentRowFromArtifact } from "@repo/app/documents/lib/artifact-row-adapter";
import {
  buildSortedGroups,
  DEFAULT_TABLE_VIEW_ORDERING,
  rootFirstTableViewOrdering,
  type TableViewOrdering,
} from "@repo/app/documents/lib/table-view-pipeline";
import { describe, expect, it } from "vitest";

const PROJECT = { id: "project-1", name: "Apollo" };
const NO_ROW_OPTIONS = () => ({});

/**
 * ISS-12929 (724-F5): the browser half of the board sort parity. The project
 * table's own comparators order the shared fixture, and the result must be
 * the order the board route returns for the same key, which
 * `apps/api/__tests__/integration/project-artifact-board-sort.test.ts`
 * asserts against the same table.
 */
describe("ISS-12929 724-F5 board sort parity: browser comparators", () => {
  it("covers every sort key in both directions", () => {
    const covered = new Set(
      BOARD_SORT_PARITY_CASES.map(
        (parityCase) =>
          `${parityCase.by}:${parityCase.direction}:${parityCase.statusOrdering}`
      )
    );
    for (const by of Object.values(ProjectArtifactBoardSort)) {
      if (by === ProjectArtifactBoardSort.StackRank) {
        continue;
      }
      for (const direction of Object.values(
        ProjectArtifactBoardSortDirection
      )) {
        expect(covered).toContain(
          `${by}:${direction}:${ArtifactSectionOrdering.Vocabulary}`
        );
      }
    }
    expect(covered).toContain(
      `${ProjectArtifactBoardSort.Status}:${ProjectArtifactBoardSortDirection.Asc}:${ArtifactSectionOrdering.RootFirst}`
    );
  });

  for (const parityCase of BOARD_SORT_PARITY_CASES) {
    it(`${parityCase.by} ${parityCase.direction} (${parityCase.statusOrdering})`, () => {
      expect(clientOrder(parityCase)).toEqual(parityCase.expected);
    });
  }
});

/** The order the project table's comparators give one case. */
function clientOrder(parityCase: BoardSortParityCase): string[] {
  const artifacts = BOARD_SORT_PARITY_ROWS.map(toArtifact);
  const treeData: ProjectTreeDetailsResponse = {
    externalParents: [],
    nodes: artifacts.map((root) => ({ children: [], root })),
  };
  const documents = artifacts.flatMap((artifact) => {
    const row = documentRowFromArtifact(artifact, PROJECT);
    return row ? [row] : [];
  });
  const { groups } = buildSortedGroups({
    documents,
    ordering: orderingFor(parityCase.statusOrdering),
    sortBy: parityCase.by as SortKey,
    sortDir: parityCase.direction,
    treeData,
  });
  return groups.map((group) => group.root.data.id);
}

function orderingFor(ordering: ArtifactSectionOrdering): TableViewOrdering {
  return ordering === ArtifactSectionOrdering.RootFirst
    ? rootFirstTableViewOrdering(NO_ROW_OPTIONS)
    : DEFAULT_TABLE_VIEW_ORDERING;
}

function toArtifact(row: BoardSortParityRow, index: number): DetailedArtifact {
  const updatedAt = new Date(
    BOARD_SORT_PARITY_EPOCH.getTime() + row.updatedMinutes * 60_000
  );
  return {
    assignee: row.assignee
      ? { avatarUrl: null, id: `user-${row.assignee.email}`, ...row.assignee }
      : null,
    assigneeId: row.assignee ? `user-${row.assignee.email}` : null,
    createdAt: BOARD_SORT_PARITY_EPOCH,
    createdById: null,
    dueDate: null,
    externalUrl: null,
    id: row.key,
    name: row.name,
    organizationId: "organization-1",
    priority: row.priority,
    projectId: PROJECT.id,
    slug: row.slug,
    sortOrder: index,
    status: row.status,
    subtype: row.subtype,
    type: row.type,
    updatedAt,
  };
}
