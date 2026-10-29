/**
 * ISS-12929 (724-F5): the SHARED oracle for the project board's sort.
 *
 * The board sorts in Postgres (`apps/api/app/artifacts/project-artifact-board-sort.ts`)
 * while the project table sorts in the browser (`ITEM_SORT_CONFIGS` and
 * `rootFirstStatusComparator` in `packages/app/documents/lib/table-view-pipeline.ts`),
 * and `apps/api` may not import `@repo/app`. Both are asserted against this one
 * table, so a divergence reddens whichever side moved.
 *
 * Consumers:
 *  - `apps/api/__tests__/integration/project-artifact-board-sort.test.ts`
 *  - `packages/app/projects/lib/__tests__/project-artifact-board-sort-parity.test.ts`
 *
 * Rows are listed in stack-rank order, which is the order the board serves
 * them unsorted and the order every tie must keep. The names are ASCII and
 * distinct once lowercased except where a tie is the point, because ICU
 * `localeCompare` and Postgres byte order agree on nothing else.
 */

import { ArtifactSubtype, ArtifactType } from "./types/artifact.ts";
import { ArtifactSectionOrdering } from "./types/artifact-group-by-mode.ts";
import { BranchStatus } from "./types/branch.ts";
import { Priority } from "./types/common.ts";
import { DocumentStatus, IssueStatus } from "./types/document.ts";
import {
  ProjectArtifactBoardSort,
  ProjectArtifactBoardSortDirection,
} from "./types/project-artifact-board-page.ts";
import { SESSION_STATUS } from "./types/session-status.ts";

export type BoardSortParityAssignee = {
  email: string;
  firstName: string | null;
  lastName: string | null;
};

export type BoardSortParityRow = {
  assignee: BoardSortParityAssignee | null;
  key: string;
  name: string;
  priority: Priority | null;
  slug: string | null;
  status: string;
  subtype: ArtifactSubtype | null;
  type: ArtifactType;
  /** Minutes after the fixture epoch. */
  updatedMinutes: number;
};

const ADA: BoardSortParityAssignee = {
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
};
const BOB_EMAIL_ONLY: BoardSortParityAssignee = {
  email: "bob@example.com",
  firstName: null,
  lastName: null,
};
const ZED: BoardSortParityAssignee = {
  email: "zed@example.com",
  firstName: "Zed",
  lastName: "Zimmer",
};

export const BOARD_SORT_PARITY_EPOCH = new Date("2026-10-01T00:00:00.000Z");

export const BOARD_SORT_PARITY_ROWS: readonly BoardSortParityRow[] = [
  {
    assignee: ADA,
    key: "issue-beta",
    name: "beta",
    priority: Priority.High,
    slug: "ISS-10",
    status: IssueStatus.Todo,
    subtype: ArtifactSubtype.Feature,
    type: ArtifactType.Document,
    updatedMinutes: 30,
  },
  {
    assignee: null,
    key: "issue-alpha",
    name: "Alpha",
    priority: null,
    slug: "ISS-9",
    status: IssueStatus.Done,
    subtype: ArtifactSubtype.Feature,
    type: ArtifactType.Document,
    updatedMinutes: 10,
  },
  {
    assignee: BOB_EMAIL_ONLY,
    key: "prd-alpha",
    name: "alpha",
    priority: Priority.Urgent,
    slug: "PRD-2",
    status: DocumentStatus.Approved,
    subtype: ArtifactSubtype.Prd,
    type: ArtifactType.Document,
    updatedMinutes: 20,
  },
  {
    assignee: ADA,
    key: "issue-off-vocabulary",
    name: "Gamma",
    priority: Priority.High,
    slug: "ISS-11",
    status: "WEIRD",
    subtype: ArtifactSubtype.Feature,
    type: ArtifactType.Document,
    updatedMinutes: 30,
  },
  {
    assignee: null,
    key: "branch-merged",
    name: "delta",
    priority: null,
    slug: null,
    status: BranchStatus.Merged,
    subtype: null,
    type: ArtifactType.Branch,
    updatedMinutes: 40,
  },
  {
    assignee: ZED,
    key: "session-active",
    name: "epsilon",
    priority: Priority.Low,
    slug: null,
    status: SESSION_STATUS.ACTIVE,
    subtype: null,
    type: ArtifactType.Session,
    updatedMinutes: 0,
  },
  {
    assignee: null,
    key: "plan-draft",
    name: "zeta",
    priority: Priority.Medium,
    slug: "PLN-1",
    status: DocumentStatus.Draft,
    subtype: ArtifactSubtype.ImplementationPlan,
    type: ArtifactType.Document,
    updatedMinutes: 5,
  },
];

export type BoardSortParityCase = {
  by: ProjectArtifactBoardSort;
  direction: ProjectArtifactBoardSortDirection;
  expected: readonly string[];
  statusOrdering: ArtifactSectionOrdering;
};

const Asc = ProjectArtifactBoardSortDirection.Asc;
const Desc = ProjectArtifactBoardSortDirection.Desc;
const Vocabulary = ArtifactSectionOrdering.Vocabulary;

export const BOARD_SORT_PARITY_CASES: readonly BoardSortParityCase[] = [
  {
    by: ProjectArtifactBoardSort.Assignee,
    direction: Asc,
    expected: [
      "issue-beta",
      "issue-off-vocabulary",
      "prd-alpha",
      "session-active",
      "issue-alpha",
      "branch-merged",
      "plan-draft",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Assignee,
    direction: Desc,
    expected: [
      "issue-alpha",
      "branch-merged",
      "plan-draft",
      "session-active",
      "prd-alpha",
      "issue-beta",
      "issue-off-vocabulary",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Priority,
    direction: Asc,
    expected: [
      "prd-alpha",
      "issue-beta",
      "issue-off-vocabulary",
      "plan-draft",
      "session-active",
      "issue-alpha",
      "branch-merged",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Priority,
    direction: Desc,
    expected: [
      "session-active",
      "plan-draft",
      "issue-beta",
      "issue-off-vocabulary",
      "prd-alpha",
      "issue-alpha",
      "branch-merged",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Slug,
    direction: Asc,
    expected: [
      "issue-alpha",
      "issue-beta",
      "issue-off-vocabulary",
      "plan-draft",
      "prd-alpha",
      "branch-merged",
      "session-active",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Slug,
    direction: Desc,
    expected: [
      "branch-merged",
      "session-active",
      "prd-alpha",
      "plan-draft",
      "issue-off-vocabulary",
      "issue-beta",
      "issue-alpha",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Status,
    direction: Asc,
    expected: [
      "plan-draft",
      "issue-off-vocabulary",
      "issue-beta",
      "prd-alpha",
      "issue-alpha",
      "branch-merged",
      "session-active",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Status,
    direction: Asc,
    expected: [
      "issue-beta",
      "plan-draft",
      "session-active",
      "prd-alpha",
      "issue-alpha",
      "branch-merged",
      "issue-off-vocabulary",
    ],
    statusOrdering: ArtifactSectionOrdering.RootFirst,
  },
  {
    by: ProjectArtifactBoardSort.Status,
    direction: Desc,
    expected: [
      "branch-merged",
      "session-active",
      "issue-alpha",
      "prd-alpha",
      "issue-beta",
      "issue-off-vocabulary",
      "plan-draft",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Status,
    direction: Desc,
    expected: [
      "issue-alpha",
      "prd-alpha",
      "branch-merged",
      "plan-draft",
      "session-active",
      "issue-beta",
      "issue-off-vocabulary",
    ],
    statusOrdering: ArtifactSectionOrdering.RootFirst,
  },
  {
    by: ProjectArtifactBoardSort.Title,
    direction: Asc,
    expected: [
      "prd-alpha",
      "issue-alpha",
      "issue-beta",
      "branch-merged",
      "session-active",
      "issue-off-vocabulary",
      "plan-draft",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Title,
    direction: Desc,
    expected: [
      "plan-draft",
      "issue-off-vocabulary",
      "session-active",
      "branch-merged",
      "issue-beta",
      "issue-alpha",
      "prd-alpha",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Type,
    direction: Asc,
    expected: [
      "branch-merged",
      "issue-beta",
      "issue-alpha",
      "issue-off-vocabulary",
      "plan-draft",
      "prd-alpha",
      "session-active",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Type,
    direction: Desc,
    expected: [
      "session-active",
      "prd-alpha",
      "plan-draft",
      "issue-beta",
      "issue-alpha",
      "issue-off-vocabulary",
      "branch-merged",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Updated,
    direction: Asc,
    expected: [
      "session-active",
      "plan-draft",
      "issue-alpha",
      "prd-alpha",
      "issue-beta",
      "issue-off-vocabulary",
      "branch-merged",
    ],
    statusOrdering: Vocabulary,
  },
  {
    by: ProjectArtifactBoardSort.Updated,
    direction: Desc,
    expected: [
      "branch-merged",
      "issue-beta",
      "issue-off-vocabulary",
      "prd-alpha",
      "issue-alpha",
      "plan-draft",
      "session-active",
    ],
    statusOrdering: Vocabulary,
  },
];
