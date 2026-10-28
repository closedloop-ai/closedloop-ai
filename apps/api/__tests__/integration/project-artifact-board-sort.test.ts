import {
  BOARD_SORT_PARITY_CASES,
  BOARD_SORT_PARITY_EPOCH,
  BOARD_SORT_PARITY_ROWS,
  type BoardSortParityAssignee,
} from "@repo/api/src/project-artifact-board-sort-parity.test-fixtures";
import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import {
  ProjectArtifactBoardGroup,
  ProjectArtifactBoardPageError,
  ProjectArtifactBoardSort,
  ProjectArtifactBoardSortDirection,
} from "@repo/api/src/types/project-artifact-board-page";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { projectArtifactBoardPageService } from "@/app/artifacts/project-artifact-board-page-service";
import { BoardStatusEvidence } from "@/app/artifacts/project-artifact-board-roots";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// The board read opens its own RepeatableRead transaction, so its rows must be
// committed rather than held in an ambient rollback transaction.
const organizations = createCommittedTestOrganizationTracker();

/**
 * ISS-12929 (724-F5): the database half of the board sort parity. Each case's
 * expected order is the one the project table's own comparators give
 * (`packages/app/projects/lib/__tests__/project-artifact-board-sort-parity.test.ts`).
 * Read in pages of two, so the order also holds across cursor continuation.
 */
describe.skipIf(!hasDatabase)("Project artifact board sort parity", () => {
  afterEach(() => organizations.cleanup());

  it("orders every sort key as the project table does, ties in stack rank", async () => {
    await organizations.run(async () => {
      const organizationId = await organizations.create();
      const viewer = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, viewer.id);
      const idByKey = await seedRows(organizationId, projectId);
      const keyById = new Map(
        [...idByKey].map(([key, id]) => [id, key] as const)
      );

      for (const parityCase of BOARD_SORT_PARITY_CASES) {
        const order = await readOrder(
          { organizationId, projectId, viewerId: viewer.id },
          parityCase
        );
        expect(
          order.map((id) => keyById.get(id)),
          `${parityCase.by} ${parityCase.direction} ${parityCase.statusOrdering}`
        ).toEqual(parityCase.expected);
      }

      const unsorted = await readOrder(
        { organizationId, projectId, viewerId: viewer.id },
        {
          by: ProjectArtifactBoardSort.StackRank,
          direction: ProjectArtifactBoardSortDirection.Desc,
          statusOrdering: ArtifactSectionOrdering.Vocabulary,
        }
      );
      expect(unsorted.map((id) => keyById.get(id))).toEqual(
        BOARD_SORT_PARITY_ROWS.map((row) => row.key)
      );
    });
  });
});

describe.skipIf(!hasDatabase)("Project artifact board sorted cursor", () => {
  afterEach(() => organizations.cleanup());

  it("refuses a cursor when an edit moved a row under the active sort", async () => {
    await organizations.run(async () => {
      const organizationId = await organizations.create();
      const viewer = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, viewer.id);
      const idByKey = await seedRows(organizationId, projectId);
      const query = {
        groupBy: ProjectArtifactBoardGroup.None,
        pageSize: 2,
        sortBy: ProjectArtifactBoardSort.Title,
        sortDir: ProjectArtifactBoardSortDirection.Asc,
      };
      const viewerScope = {
        statusEvidence: BoardStatusEvidence.Stored,
        statusOrdering: ArtifactSectionOrdering.Vocabulary,
        userId: viewer.id,
      };
      const first = await projectArtifactBoardPageService.read(
        projectId,
        organizationId,
        query,
        viewerScope
      );
      if (!(first.ok && first.value.nextCursor)) {
        throw new Error("expected a second page");
      }
      const renamedId = idByKey.get("plan-draft");
      await withDb((db) =>
        db.artifact.update({
          where: { id: renamedId },
          data: { name: "aardvark" },
        })
      );
      const second = await projectArtifactBoardPageService.read(
        projectId,
        organizationId,
        { ...query, cursor: first.value.nextCursor },
        viewerScope
      );
      expect(second).toMatchObject({
        ok: false,
        error: { code: ProjectArtifactBoardPageError.StaleRevision },
      });
    });
  });
});

async function seedRows(organizationId: string, projectId: string) {
  const userIdByEmail = new Map<string, string>();
  const idByKey = new Map<string, string>();
  for (const [index, row] of BOARD_SORT_PARITY_ROWS.entries()) {
    const assigneeId = row.assignee
      ? await seededAssignee(organizationId, row.assignee, userIdByEmail)
      : null;
    const created = await withDb((db) =>
      db.artifact.create({
        data: {
          assigneeId,
          name: row.name,
          organizationId,
          priority: row.priority,
          projectId,
          slug: row.slug,
          sortOrder: index,
          status: row.status,
          subtype: row.subtype,
          type: row.type,
          updatedAt: new Date(
            BOARD_SORT_PARITY_EPOCH.getTime() + row.updatedMinutes * 60_000
          ),
        },
        select: { id: true },
      })
    );
    idByKey.set(row.key, created.id);
  }
  return idByKey;
}

async function seededAssignee(
  organizationId: string,
  assignee: BoardSortParityAssignee,
  userIdByEmail: Map<string, string>
) {
  const existing = userIdByEmail.get(assignee.email);
  if (existing) {
    return existing;
  }
  const user = await createTestUser(organizationId);
  await withDb((db) =>
    db.user.update({
      where: { id: user.id },
      data: {
        // Unique across runs, so the address is tagged after its local part,
        // which keeps it sorting where the fixture's address sorts.
        email: assignee.email.replace("@", `+${organizationId}@`),
        firstName: assignee.firstName,
        lastName: assignee.lastName,
      },
    })
  );
  userIdByEmail.set(assignee.email, user.id);
  return user.id;
}

async function readOrder(
  scope: { organizationId: string; projectId: string; viewerId: string },
  sort: {
    by: ProjectArtifactBoardSort;
    direction: ProjectArtifactBoardSortDirection;
    statusOrdering: ArtifactSectionOrdering;
  }
) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await projectArtifactBoardPageService.read(
      scope.projectId,
      scope.organizationId,
      {
        ...(cursor ? { cursor } : {}),
        groupBy: ProjectArtifactBoardGroup.None,
        pageSize: 2,
        sortBy: sort.by,
        sortDir: sort.direction,
      },
      {
        statusEvidence: BoardStatusEvidence.Stored,
        statusOrdering: sort.statusOrdering,
        userId: scope.viewerId,
      }
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    ids.push(...result.value.rootIds);
    cursor = result.value.nextCursor;
  } while (cursor);
  return ids;
}
