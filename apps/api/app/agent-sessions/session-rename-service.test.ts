import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  SessionMetadataActivityField,
} from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `$queryRaw` is the artifact-row lock, then the ISS-9486 locked read of the
// rendered name. It answers no row by default, which is what a caller the write
// refuses would see and what leaves every case below on the write path it
// asserts.
const mockDb = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  sessionDetail: {
    updateMany: vi.fn(),
    findFirst: vi.fn(),
  },
}));

vi.mock("@repo/database", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    empty: {},
  },
  withDb: Object.assign(
    (fn: (client: typeof mockDb) => unknown) => fn(mockDb),
    { tx: (fn: (tx: typeof mockDb) => unknown) => fn(mockDb) }
  ),
}));

vi.mock("@/app/search/search-index-service", () => ({
  searchIndexService: {
    updateTitleAfterCommit: vi.fn(),
  },
}));

vi.mock("@/lib/artifact-activity-capture", () => ({
  resolveActorType: vi.fn(),
}));
vi.mock("@/lib/artifact-field-edit-capture", () => ({
  captureArtifactMetadataChange: vi.fn(),
}));

const captureArtifactFieldEditAnalytics = vi.hoisted(() => vi.fn());
vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics,
}));

import { searchIndexService } from "@/app/search/search-index-service";
import { resolveActorType } from "@/lib/artifact-activity-capture";
import { captureArtifactMetadataChange } from "@/lib/artifact-field-edit-capture";
import { sessionRenameService } from "./session-rename-service";

const VALID_UUID = "72ffc277-1659-4446-a89e-75e7c96e7e2e";

// The tenancy half of the authorization predicate. It rides the same `where` as
// the ownership narrowing, so a test that pins only the assignee leaves org and
// artifact-type unguarded.
const ARTIFACT_SCOPE = {
  is: { organizationId: "org-1", type: ArtifactType.Session },
};

// ISS-12251 D-6: a non-admin renames only a session assigned to them.
const ASSIGNED_SCOPE = {
  is: { ...ARTIFACT_SCOPE.is, assigneeId: "user-1" },
};

describe("sessionRenameService.rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.$queryRaw.mockResolvedValue([{ currentName: "Old Name" }]);
    vi.mocked(resolveActorType).mockReturnValue(ArtifactActivityActorType.User);
  });

  it("returns NotFound for a non-uuid id", async () => {
    const result = await sessionRenameService.rename({
      id: "not-a-uuid",
      organizationId: "org-1",
      actorUserId: "user-1",
      authMethod: "session",
      actorIsOrgAdmin: false,
      name: "New Name",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
    expect(mockDb.sessionDetail.updateMany).not.toHaveBeenCalled();
  });

  it("renames successfully when the owner writes", async () => {
    mockDb.sessionDetail.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await sessionRenameService.rename({
      id: VALID_UUID,
      organizationId: "org-1",
      actorUserId: "user-1",
      authMethod: "session",
      actorIsOrgAdmin: false,
      name: "Renamed Session",
    });

    expect(result.ok).toBe(true);
    expect(mockDb.sessionDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: VALID_UUID,
        artifact: ASSIGNED_SCOPE,
      },
      data: { nameOverride: "Renamed Session" },
    });
    expect(captureArtifactMetadataChange).toHaveBeenCalledWith({
      tx: mockDb,
      organizationId: "org-1",
      artifactId: VALID_UUID,
      actorType: ArtifactActivityActorType.User,
      actorId: "user-1",
      action: ArtifactActivityAction.FieldChange,
      field: SessionMetadataActivityField.Name,
      before: "Old Name",
      after: "Renamed Session",
    });
    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.Name,
      result: ArtifactFieldEditOutcome.Committed,
      artifactCount: 1,
      after: "Renamed Session",
    });
  });

  it("does not write a receipt when the rendered name already matches", async () => {
    mockDb.$queryRaw
      .mockResolvedValueOnce([{ id: VALID_UUID }])
      .mockResolvedValueOnce([{ currentName: "Renamed Session" }]);

    const result = await sessionRenameService.rename({
      id: VALID_UUID,
      organizationId: "org-1",
      actorUserId: "user-1",
      authMethod: "session",
      actorIsOrgAdmin: false,
      name: "Renamed Session",
    });

    expect(result.ok).toBe(true);
    expect(mockDb.sessionDetail.updateMany).not.toHaveBeenCalled();
    expect(captureArtifactMetadataChange).not.toHaveBeenCalled();
    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.Name,
      result: ArtifactFieldEditOutcome.NoChange,
      artifactCount: 1,
      after: "Renamed Session",
    });
  });

  it("attributes an API-key rename to an agent", async () => {
    mockDb.sessionDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    vi.mocked(resolveActorType).mockReturnValue(
      ArtifactActivityActorType.Agent
    );

    await sessionRenameService.rename({
      id: VALID_UUID,
      organizationId: "org-1",
      actorUserId: "user-1",
      authMethod: "api_key",
      actorIsOrgAdmin: false,
      name: "Agent Rename",
    });

    expect(resolveActorType).toHaveBeenCalledWith("api_key");
    expect(captureArtifactMetadataChange).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: ArtifactActivityActorType.Agent,
        actorId: "user-1",
      })
    );
  });

  it("fails the rename when its atomic receipt fails", async () => {
    mockDb.sessionDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    const failure = new Error("receipt unavailable");
    vi.mocked(captureArtifactMetadataChange).mockRejectedValueOnce(failure);

    await expect(
      sessionRenameService.rename({
        id: VALID_UUID,
        organizationId: "org-1",
        actorUserId: "user-1",
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: "New Name",
      })
    ).rejects.toBe(failure);
    expect(searchIndexService.updateTitleAfterCommit).not.toHaveBeenCalled();
  });

  it("narrows a non-admin write to the sessions assigned to them", async () => {
    mockDb.sessionDetail.updateMany.mockResolvedValueOnce({ count: 1 });

    await sessionRenameService.rename({
      id: VALID_UUID,
      organizationId: "org-1",
      actorUserId: "user-1",
      authMethod: "session",
      actorIsOrgAdmin: false,
      name: "Test",
    });

    expect(mockDb.sessionDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: VALID_UUID,
        artifact: ASSIGNED_SCOPE,
      },
      data: { nameOverride: "Test" },
    });
  });

  it("drops the assignee predicate for an org admin", async () => {
    mockDb.sessionDetail.updateMany.mockResolvedValueOnce({ count: 1 });

    await sessionRenameService.rename({
      id: VALID_UUID,
      organizationId: "org-1",
      actorUserId: "admin-1",
      authMethod: "session",
      actorIsOrgAdmin: true,
      name: "Admin Rename",
    });

    // Only the ownership narrowing is dropped for an admin. Org and artifact
    // type stay, so an admin cannot rename a guessed foreign-tenant session or
    // a same-org non-session artifact that happens to carry a detail row.
    expect(mockDb.sessionDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: VALID_UUID,
        artifact: ARTIFACT_SCOPE,
      },
      data: { nameOverride: "Admin Rename" },
    });
  });

  it("calls updateTitleAfterCommit on success", async () => {
    mockDb.sessionDetail.updateMany.mockResolvedValueOnce({ count: 1 });

    await sessionRenameService.rename({
      id: VALID_UUID,
      organizationId: "org-1",
      actorUserId: "user-1",
      authMethod: "session",
      actorIsOrgAdmin: false,
      name: "New Title",
    });

    expect(searchIndexService.updateTitleAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        entityId: VALID_UUID,
      }),
      "New Title"
    );
  });

  it("returns Forbidden when session exists but actor is not owner", async () => {
    mockDb.sessionDetail.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.sessionDetail.findFirst.mockResolvedValueOnce({
      artifactId: VALID_UUID,
    });

    const result = await sessionRenameService.rename({
      id: VALID_UUID,
      organizationId: "org-1",
      actorUserId: "wrong-user",
      authMethod: "session",
      actorIsOrgAdmin: false,
      name: "No Access",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    // The refusal-classifying read carries the same tenancy scope as the write,
    // so a cross-org or non-session id reads as NotFound rather than a
    // Forbidden that would confirm a session exists at that id.
    expect(mockDb.sessionDetail.findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: VALID_UUID,
        artifact: ARTIFACT_SCOPE,
      },
      select: { artifactId: true },
    });
    expect(captureArtifactFieldEditAnalytics).not.toHaveBeenCalled();
  });

  it("returns NotFound when session does not exist in the org", async () => {
    mockDb.sessionDetail.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.sessionDetail.findFirst.mockResolvedValueOnce(null);

    const result = await sessionRenameService.rename({
      id: VALID_UUID,
      organizationId: "org-1",
      actorUserId: "user-1",
      authMethod: "session",
      actorIsOrgAdmin: false,
      name: "Gone",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
    expect(mockDb.sessionDetail.findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: VALID_UUID,
        artifact: ARTIFACT_SCOPE,
      },
      select: { artifactId: true },
    });
    expect(captureArtifactFieldEditAnalytics).not.toHaveBeenCalled();
  });

  it("passes the requested name only to the value-safe analytics boundary", async () => {
    mockDb.$queryRaw
      .mockResolvedValueOnce([{ id: VALID_UUID }])
      .mockResolvedValueOnce([{ currentName: "Current private name" }]);

    const result = await sessionRenameService.rename({
      id: VALID_UUID,
      organizationId: "org-1",
      actorUserId: "user-1",
      authMethod: "session",
      actorIsOrgAdmin: false,
      name: "Requested private name",
      expectedName: "Older private name",
    });

    expect(result.ok).toBe(false);
    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.Name,
      result: ArtifactFieldEditOutcome.Conflict,
      artifactCount: 1,
      after: "Requested private name",
    });
  });

  it("does not call updateTitleAfterCommit on failure", async () => {
    mockDb.sessionDetail.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.sessionDetail.findFirst.mockResolvedValueOnce(null);

    await sessionRenameService.rename({
      id: VALID_UUID,
      organizationId: "org-1",
      actorUserId: "user-1",
      authMethod: "session",
      actorIsOrgAdmin: false,
      name: "No Write",
    });

    expect(searchIndexService.updateTitleAfterCommit).not.toHaveBeenCalled();
  });
});
