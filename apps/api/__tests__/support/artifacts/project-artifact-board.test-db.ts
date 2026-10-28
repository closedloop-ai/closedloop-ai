/**
 * Real-database fixture for the project board page suites (ISS-12929): one
 * project with two members, committed roots, and a full cursor walk.
 */

import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import type { Priority } from "@repo/api/src/types/common";
import {
  type ProjectArtifactBoardFilters,
  ProjectArtifactBoardGroup,
  type ProjectArtifactBoardPageResponse,
} from "@repo/api/src/types/project-artifact-board-page";
import { withDb } from "@repo/database";
import {
  type createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { projectArtifactBoardPageService } from "@/app/artifacts/project-artifact-board-page-service";
import { BoardStatusEvidence } from "@/app/artifacts/project-artifact-board-roots";

type CommittedOrganizations = ReturnType<
  typeof createCommittedTestOrganizationTracker
>;

export type BoardFixture = {
  organizationId: string;
  projectId: string;
  userId: string;
  otherUserId: string;
};

export async function seedBoardRoot(
  fixture: BoardFixture,
  input: {
    name: string;
    sortOrder: number;
    status: string;
    type?: ArtifactType;
    subtype?: ArtifactSubtype | null;
    priority?: Priority | null;
    slug?: string;
    assigneeId?: string | null;
    createdAt?: Date;
  }
): Promise<string> {
  const type = input.type ?? ArtifactType.Document;
  const row = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        type,
        subtype: seededSubtype(type, input.subtype),
        name: input.name,
        status: input.status,
        sortOrder: input.sortOrder,
        priority: input.priority ?? null,
        slug: input.slug ?? null,
        assigneeId: input.assigneeId ?? null,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
      select: { id: true },
    })
  );
  return row.id;
}

export async function readBoardRoots(
  fixture: BoardFixture,
  filters?: ProjectArtifactBoardFilters,
  pageSize = 50,
  statusEvidence: BoardStatusEvidence = BoardStatusEvidence.Stored
) {
  const pages: ProjectArtifactBoardPageResponse[] = [];
  let cursor: string | undefined;
  do {
    const result = await projectArtifactBoardPageService.read(
      fixture.projectId,
      fixture.organizationId,
      {
        groupBy: ProjectArtifactBoardGroup.Status,
        pageSize,
        ...(cursor ? { cursor } : {}),
        ...(filters ? { filters } : {}),
      },
      {
        statusEvidence,
        statusOrdering: ArtifactSectionOrdering.Vocabulary,
        userId: fixture.userId,
      }
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    pages.push(result.value);
    cursor = result.value.nextCursor;
  } while (cursor);
  return {
    pages,
    rootIds: pages.flatMap((page) => page.rootIds),
    counts: Object.fromEntries(
      (pages[0]?.lanes ?? []).map((lane) => [lane.id, lane.count])
    ),
  };
}

export async function withBoardFixture(
  organizations: CommittedOrganizations,
  run: (fixture: BoardFixture) => Promise<void>
) {
  await organizations.run(async () => {
    const organizationId = await organizations.create();
    const user = await createTestUser(organizationId);
    const other = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, user.id);
    await run({
      organizationId,
      projectId,
      userId: user.id,
      otherUserId: other.id,
    });
  });
}

function seededSubtype(
  type: ArtifactType,
  subtype: ArtifactSubtype | null | undefined
): ArtifactSubtype | null {
  if (subtype !== undefined) {
    return subtype;
  }
  return type === ArtifactType.Document ? ArtifactSubtype.Feature : null;
}
