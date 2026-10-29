import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { beforeEach, vi } from "vitest";
import { mocks } from "@/__tests__/support/documents/project-artifact-placement-service.test-mocks";
import { projectArtifactPlacementService } from "@/app/documents/project-artifact-placement-service";

export const ORG_ID = "00000000-0000-4000-8000-000000000001";
export const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
export const ROOT_RANK_UPDATE_PATTERN =
  /UPDATE\s+"artifacts"[\s\S]+SET\s+"sort_order"/;
export const CHILD_RANK_UPDATE_PATTERN =
  /UPDATE\s+"artifact_links"[\s\S]+SET\s+"sort_order"/;
export const SOURCE_ID = "00000000-0000-4000-8000-000000000003";
export const TARGET_ID = "00000000-0000-4000-8000-000000000004";
export const ACTOR_ID = "00000000-0000-4000-8000-000000000005";
export const TRANSACTION_ID = "00000000-0000-4000-8000-000000000006";
export const DESTINATION_ID = "00000000-0000-4000-8000-000000000007";
export const DESTINATION_TARGET_ID = "00000000-0000-4000-8000-000000000008";
export const SECOND_PARENT_ID = "00000000-0000-4000-8000-000000000009";
export const CREATED_AT = new Date("2026-10-19T12:00:00.000Z");

let storedActivityAfter: unknown = null;

export function client(): Record<string, unknown> {
  return {
    $executeRaw: mocks.executeRaw,
    $queryRaw: mocks.queryRaw,
    artifact: {
      findFirst: mocks.artifactFindFirst,
      findMany: mocks.artifactFindMany,
      updateMany: mocks.artifactUpdateMany,
      update: mocks.artifactUpdate,
    },
    artifactActivityEvent: {
      create: mocks.activityCreate,
      createMany: mocks.activityCreateMany,
      findFirst: mocks.activityFindFirst,
      findMany: mocks.activityFindMany,
    },
    artifactLink: {
      create: mocks.artifactLinkCreate,
      createMany: mocks.artifactLinkCreateMany,
      deleteMany: mocks.artifactLinkDeleteMany,
      findMany: mocks.artifactLinkFindMany,
    },
    project: {
      findFirst: mocks.projectFindFirst,
      findMany: mocks.projectFindMany,
    },
    user: { findFirst: mocks.userFindFirst },
    apiKey: { findFirst: vi.fn() },
    desktopSession: { findFirst: vi.fn() },
  };
}

export function request(overrides: Record<string, unknown> = {}) {
  return {
    kind: ProjectArtifactPlacementKind.Place,
    sourceArtifactIds: [SOURCE_ID],
    destinationProjectId: PROJECT_ID,
    position: ProjectArtifactPlacementPosition.After,
    targetArtifactId: TARGET_ID,
    expectedProjectVersions: {},
    idempotencyKey: "placement-1",
    source: ProjectArtifactPlacementSource.Pointer,
    ...overrides,
  };
}

export async function currentVersion(): Promise<string> {
  const state = await projectArtifactPlacementService.getProjectPlacementState(
    PROJECT_ID,
    ORG_ID,
    { userId: ACTOR_ID, authMethod: "session" }
  );
  if (!state) {
    throw new Error("expected project version");
  }
  return state.projectVersion;
}

export function mockArtifactRows(includeSecondParent = false) {
  mocks.artifactFindMany.mockImplementation(
    ({ where }: { where: { id?: { in: string[] } } }) => {
      const rows = [
        {
          id: SOURCE_ID,
          projectId: PROJECT_ID,
          sortOrder: 0,
          createdAt: CREATED_AT,
          assigneeId: null,
          dueDate: null,
          name: "Source",
          organizationId: ORG_ID,
          priority: null,
          status: IssueStatus.Todo,
          subtype: ArtifactSubtype.Feature,
          tagArtifacts: [],
          type: ArtifactType.Document,
          updatedAt: CREATED_AT,
        },
        {
          id: TARGET_ID,
          projectId: PROJECT_ID,
          sortOrder: 1024,
          createdAt: CREATED_AT,
          assigneeId: null,
          dueDate: null,
          name: "Target",
          organizationId: ORG_ID,
          priority: null,
          status: IssueStatus.Todo,
          subtype: ArtifactSubtype.Feature,
          tagArtifacts: [],
          type: ArtifactType.Document,
          updatedAt: CREATED_AT,
        },
        {
          id: DESTINATION_TARGET_ID,
          projectId: DESTINATION_ID,
          sortOrder: 0,
          createdAt: CREATED_AT,
          assigneeId: null,
          dueDate: null,
          name: "Destination",
          organizationId: ORG_ID,
          priority: null,
          status: IssueStatus.Todo,
          subtype: ArtifactSubtype.Feature,
          tagArtifacts: [],
          type: ArtifactType.Document,
          updatedAt: CREATED_AT,
        },
        ...(includeSecondParent
          ? [
              {
                id: SECOND_PARENT_ID,
                projectId: PROJECT_ID,
                sortOrder: 2048,
                createdAt: CREATED_AT,
              },
            ]
          : []),
      ];
      return Promise.resolve(
        where.id?.in ? rows.filter(({ id }) => where.id?.in.includes(id)) : rows
      );
    }
  );
}

/** Register the shared fixture defaults every placement service case starts from. */
export function installPlacementHarness() {
  beforeEach(() => {
    vi.clearAllMocks();
    storedActivityAfter = null;
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(TRANSACTION_ID);
    mocks.projectFindFirst.mockResolvedValue({ id: PROJECT_ID });
    mocks.projectFindMany.mockResolvedValue([{ id: PROJECT_ID }]);
    mocks.userFindFirst.mockResolvedValue({ id: ACTOR_ID });
    mocks.artifactFindFirst.mockResolvedValue({
      id: TARGET_ID,
      projectId: PROJECT_ID,
    });
    mockArtifactRows();
    mocks.artifactLinkFindMany.mockResolvedValue([]);
    mocks.artifactLinkDeleteMany.mockResolvedValue({ count: 0 });
    mocks.artifactLinkCreate.mockResolvedValue({ id: "link" });
    mocks.artifactLinkCreateMany.mockResolvedValue({ count: 1 });
    mocks.artifactUpdateMany.mockResolvedValue({ count: 0 });
    mocks.artifactUpdate.mockResolvedValue({ id: SOURCE_ID });
    mocks.activityCreate.mockResolvedValue({ id: "activity" });
    mocks.activityFindMany.mockResolvedValue([]);
    mocks.activityFindFirst.mockImplementation(() =>
      Promise.resolve(
        storedActivityAfter === null ? null : { after: storedActivityAfter }
      )
    );
    mocks.activityCreateMany.mockImplementation(
      ({ data }: { data: Array<{ after?: unknown }> }) => {
        storedActivityAfter = data.find(
          (row) =>
            row.after && typeof row.after === "object" && "receipt" in row.after
        )?.after;
        return Promise.resolve({ count: data.length });
      }
    );
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValue([]);
    const fakeClient = client();
    mocks.withDb.mockImplementation((handler: (db: unknown) => unknown) =>
      handler(fakeClient)
    );
    mocks.withDb.tx.mockImplementation((handler: (db: unknown) => unknown) =>
      handler(fakeClient)
    );
  });
}
