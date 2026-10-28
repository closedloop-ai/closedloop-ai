import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import { ProjectArtifactBoardPageError } from "@repo/api/src/types/project-artifact-board-page";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown }) =>
      handler(mockAuthContext, request, context?.params),
}));

vi.mock("@/lib/identifier-utils", () => ({ resolveProjectId: vi.fn() }));

vi.mock("@/app/artifacts/project-artifact-board-page-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/artifacts/project-artifact-board-page-service")
  >("@/app/artifacts/project-artifact-board-page-service");
  return {
    ...actual,
    projectArtifactBoardPageService: { read: vi.fn() },
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/app/artifacts/project-artifact-board-status-evidence", () => ({
  resolveBoardStatusEvidence: vi.fn(
    async () =>
      (await import("@/app/artifacts/project-artifact-board-roots"))
        .BoardStatusEvidence.Stored
  ),
  resolveBoardStatusOrdering: vi.fn(
    async () =>
      (await import("@repo/api/src/types/artifact-group-by-mode"))
        .ArtifactSectionOrdering.Vocabulary
  ),
}));

import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER,
  ProjectArtifactBoardGroup,
  ProjectArtifactBoardKind,
  ProjectArtifactBoardStatusMatch,
  projectArtifactBoardPagePath,
} from "@repo/api/src/types/project-artifact-board-page";
import { Result, Status } from "@repo/api/src/types/result";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { projectArtifactBoardPageService } from "@/app/artifacts/project-artifact-board-page-service";
import { BoardStatusEvidence } from "@/app/artifacts/project-artifact-board-roots";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../../__tests__/utils/auth-helpers";
import { GET } from "./route";

const PROJECT_ID = "11111111-1111-7111-8111-111111111111";
const PROJECT_SLUG = "PRO-7";
const REVISION = "a".repeat(64);
const mockRead = vi.mocked(projectArtifactBoardPageService.read);
const mockResolveProjectId = vi.mocked(resolveProjectId);

function request(query: string) {
  return GET(
    createMockRequest({
      url: `http://localhost:3002/projects/${PROJECT_SLUG}/artifacts/board?${query}`,
    }),
    createMockRouteContext({ id: PROJECT_SLUG })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mockResolveProjectId.mockResolvedValue(PROJECT_ID);
});

describe("CT-08 GET /projects/[id]/artifacts/board", () => {
  it("passes the resolved project and caller organization to the board service", async () => {
    mockRead.mockResolvedValue(
      Result.ok({ lanes: [], populationRevision: REVISION, rootIds: [] })
    );
    const response = await request(
      `groupBy=${ProjectArtifactBoardGroup.Status}&pageSize=20`
    );
    expect(response.status).toBe(200);
    expect(mockRead).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId,
      { filters: {}, groupBy: ProjectArtifactBoardGroup.Status, pageSize: 20 },
      {
        statusEvidence: BoardStatusEvidence.Stored,
        statusOrdering: ArtifactSectionOrdering.Vocabulary,
        userId: mockAuthContext.user.id,
      }
    );
  });

  it("ISS-12929 724-F5 carries the table filters, repeated values included, to the service", async () => {
    mockRead.mockResolvedValue(
      Result.ok({ lanes: [], populationRevision: REVISION, rootIds: [] })
    );
    const assigneeId = "33333333-3333-7333-8333-333333333333";
    const tagId = "44444444-4444-7444-8444-444444444444";
    const response = await request(
      [
        `groupBy=${ProjectArtifactBoardGroup.Status}`,
        `assigneeId=${assigneeId}`,
        `assigneeId=${PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER}`,
        `status=${IssueStatus.Todo}`,
        `status=${IssueStatus.Done}`,
        `priority=${PRIORITY_UNSET_VALUE}`,
        `tagId=${tagId}`,
        "favoritesOnly=true",
        "hideCompletedItems=true",
        `dateField=${ArtifactDateField.UpdatedAt}`,
        "dateFrom=2026-10-01T00:00:00.000Z",
        "dateTo=2026-10-08T00:00:00.000Z",
        "search=%20apollo%20",
      ].join("&")
    );
    expect(response.status).toBe(200);
    expect(mockRead).toHaveBeenCalledWith(
      PROJECT_ID,
      mockAuthContext.user.organizationId,
      expect.objectContaining({
        filters: {
          assigneeIds: [assigneeId, PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER],
          dateWindow: {
            field: ArtifactDateField.UpdatedAt,
            from: new Date("2026-10-01T00:00:00.000Z"),
            to: new Date("2026-10-08T00:00:00.000Z"),
          },
          favoritesOnly: true,
          hideCompletedItems: true,
          priorities: [PRIORITY_UNSET_VALUE],
          search: "apollo",
          statuses: [IssueStatus.Todo, IssueStatus.Done],
          tagIds: [tagId],
        },
      }),
      {
        statusEvidence: BoardStatusEvidence.Stored,
        statusOrdering: ArtifactSectionOrdering.Vocabulary,
        userId: mockAuthContext.user.id,
      }
    );
  });

  it("ISS-12929 carries the portable list toolbar facets through the shared path", async () => {
    mockRead.mockResolvedValue(
      Result.ok({ lanes: [], populationRevision: REVISION, rootIds: [] })
    );
    const tagId = "44444444-4444-7444-8444-444444444444";
    const filters = {
      anyKindPriorities: [Priority.High],
      anyKindTagIds: [tagId],
      kindStatuses: [
        {
          kind: ProjectArtifactBoardKind.Issue,
          match: ProjectArtifactBoardStatusMatch.Only,
          statuses: [IssueStatus.Todo, IssueStatus.Done],
        },
        {
          kind: ProjectArtifactBoardKind.Session,
          match: ProjectArtifactBoardStatusMatch.Except,
          statuses: [],
        },
      ],
      kinds: [ProjectArtifactBoardKind.Issue, ProjectArtifactBoardKind.Session],
      mineOnly: true,
      slugOrTitle: "apollo",
      parentIds: [tagId],
      relatedSessionIds: [tagId],
      customFieldValues: [{ fieldId: tagId, labels: ["Beta: rc", "GA"] }],
      customFieldRanges: [{ fieldId: tagId, max: 5, min: -1.5 }],
    };
    const path = projectArtifactBoardPagePath(PROJECT_ID, {
      filters,
      groupBy: ProjectArtifactBoardGroup.Status,
      pageSize: 20,
    });
    const response = await request(path.slice(path.indexOf("?") + 1));
    expect(response.status).toBe(200);
    expect(mockRead.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ filters })
    );

    mockRead.mockClear();
    const emptyFacet = projectArtifactBoardPagePath(PROJECT_ID, {
      filters: { kindStatuses: [] },
      groupBy: ProjectArtifactBoardGroup.Status,
      pageSize: 20,
    });
    await request(emptyFacet.slice(emptyFacet.indexOf("?") + 1));
    expect(mockRead.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ filters: { kindStatuses: [] } })
    );
  });

  it("ISS-12929 refuses a malformed or contradictory kind status", async () => {
    for (const query of [
      "kindStatus=Agent:only:TODO",
      "kindStatus=Issue:sometimes:TODO",
      "kindStatus=Issue:only:TODO&kindStatus=Issue:except:DONE",
      "kind=Prototype",
      "anyKindPriority=NONE",
      "customFieldValue=not-a-field:Beta",
      "customFieldRange=44444444-4444-7444-8444-444444444444:low:",
      "parentId=not-an-id",
    ]) {
      const response = await request(
        `groupBy=${ProjectArtifactBoardGroup.Status}&${query}`
      );
      expect(response.status, query).toBe(400);
    }
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("ISS-12929 724-F5 refuses a filter it cannot honor rather than widening", async () => {
    for (const query of [
      "status=NOT_A_STATUS",
      "priority=URGENTISH",
      "assigneeId=not-a-user",
      `dateField=${ArtifactDateField.UpdatedAt}`,
      `dateField=${ArtifactDateField.UpdatedAt}&dateFrom=2026-10-08T00:00:00.000Z&dateTo=2026-10-01T00:00:00.000Z`,
      "favoritesOnly=yes",
      "sortBy=colour",
      "sortBy=title&sortDir=sideways",
      "search=%00",
      `search=${"a".repeat(201)}`,
    ]) {
      const response = await request(
        `groupBy=${ProjectArtifactBoardGroup.Status}&${query}`
      );
      expect(response.status).toBe(400);
    }
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("rejects unknown query keys and out-of-scope projects before reading", async () => {
    const malformed = await request(
      `groupBy=${ProjectArtifactBoardGroup.Status}&fixtureOnly=true`
    );
    expect(malformed.status).toBe(400);
    expect(mockRead).not.toHaveBeenCalled();

    mockResolveProjectId.mockResolvedValue(null);
    const missing = await request(
      `groupBy=${ProjectArtifactBoardGroup.Status}`
    );
    expect(missing.status).toBe(404);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("maps stale population revisions to 409 without returning lane data", async () => {
    mockRead.mockResolvedValue(
      Result.err({
        code: ProjectArtifactBoardPageError.StaleRevision,
        message: "Project ordering changed since it was read",
        status: Status.Conflict,
      })
    );
    const response = await request(
      `groupBy=${ProjectArtifactBoardGroup.Status}&cursor=stale`
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      code: ProjectArtifactBoardPageError.StaleRevision,
      error: "Project ordering changed since it was read",
    });
  });
});
