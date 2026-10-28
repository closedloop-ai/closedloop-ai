import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import { IssueStatus } from "@repo/api/src/types/document";
import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDbIssue,
  createDbProducesLink,
} from "@/__tests__/support/artifacts/artifact-hierarchy.test-db";
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
 * PRD-724: a project board renders root artifacts only, in its cards and in its
 * lane counts (web-master prototype `project-hierarchy-spec.ts`,
 * `boardRootsOnly: true`). The unit suite mocks Prisma, so only a real query can
 * prove the PRODUCES filter keeps nested rows out.
 */
describe.skipIf(!hasDatabase)("Project artifact board roots only", () => {
  afterEach(() => organizations.cleanup());

  it("leaves nested artifacts out of cards, root ids and lane counts", async () => {
    await organizations.run(async () => {
      const organizationId = await organizations.create();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      const root = await createDbIssue({
        organizationId,
        projectId,
        name: "Root",
        status: IssueStatus.Todo,
        sortOrder: 0,
      });
      const child = await createDbIssue({
        organizationId,
        projectId,
        name: "Child",
        status: IssueStatus.Todo,
        sortOrder: 1,
      });
      const grandchild = await createDbIssue({
        organizationId,
        projectId,
        name: "Grandchild",
        status: IssueStatus.Done,
        sortOrder: 2,
      });
      const otherRoot = await createDbIssue({
        organizationId,
        projectId,
        name: "Other root",
        status: IssueStatus.Done,
        sortOrder: 3,
      });
      await createDbProducesLink(organizationId, root.id, child.id);
      await createDbProducesLink(organizationId, child.id, grandchild.id);

      const result = await projectArtifactBoardPageService.read(
        projectId,
        organizationId,
        { groupBy: ProjectArtifactBoardGroup.Status, pageSize: 50 },
        {
          statusEvidence: BoardStatusEvidence.Stored,
          statusOrdering: ArtifactSectionOrdering.Vocabulary,
          userId: user.id,
        }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.rootIds).toEqual([root.id, otherRoot.id]);
      const cardIds = result.value.lanes.flatMap((lane) =>
        lane.cards.map((card) => card.artifact.id)
      );
      expect(cardIds).toEqual(expect.arrayContaining([root.id, otherRoot.id]));
      expect(cardIds).not.toContain(child.id);
      expect(cardIds).not.toContain(grandchild.id);
      const lanes = Object.fromEntries(
        result.value.lanes.map((lane) => [lane.id, lane.count])
      );
      expect(lanes).toEqual({
        [IssueStatus.Todo]: 1,
        [IssueStatus.Done]: 1,
      });
      const rootCard = result.value.lanes
        .flatMap((lane) => lane.cards)
        .find((card) => card.artifact.id === root.id);
      expect(rootCard?.descendantCount).toBe(2);
    });
  });
});
