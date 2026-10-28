import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  SessionMetadataActivityField,
} from "@repo/api/src/types/artifact-activity";
import { TagEntityType } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbAll } from "@/__tests__/utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

const captureArtifactMetadataChange = vi.hoisted(() => vi.fn());
const captureArtifactFieldEditAnalytics = vi.hoisted(() => vi.fn());
vi.mock("@/lib/artifact-activity-capture", () => ({
  resolveActorType: (authMethod: string) =>
    authMethod === "api_key"
      ? ArtifactActivityActorType.Agent
      : ArtifactActivityActorType.User,
}));
vi.mock("@/lib/artifact-field-edit-capture", () => ({
  captureArtifactMetadataChange,
}));
vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics,
}));

const labelReconciliation = vi.hoisted(() => ({
  reconcileLinkedPullRequestLabelsForArtifact: vi.fn(),
  reconcileLinkedPullRequestLabelsForArtifacts: vi.fn(),
}));
vi.mock(
  "@/lib/github/artifact-tag-label-reconciliation",
  () => labelReconciliation
);

import { tagService } from "./service";

const organizationId = "org-1";
const branchId = "branch-1";
const tagId = "tag-1";
const actor = { userId: "user-1", authMethod: "session" } as const;

function branchTagDb(
  removeCount = 1,
  artifactType: ArtifactType = ArtifactType.Branch
) {
  return {
    tag: { findFirst: vi.fn().mockResolvedValue({ id: tagId }) },
    artifact: {
      findFirst: vi.fn().mockResolvedValue({
        id: branchId,
        type: artifactType,
      }),
    },
    tagArtifact: {
      create: vi.fn().mockResolvedValue({ id: "relation-1" }),
      deleteMany: vi.fn().mockResolvedValue({ count: removeCount }),
    },
  };
}

describe("Branch tag activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records one actor-attributed add on the tag transaction", async () => {
    const db = branchTagDb();
    mockWithDbAll(db);

    await tagService.applyTag(
      tagId,
      TagEntityType.Artifact,
      branchId,
      organizationId,
      actor
    );

    expect(db.tagArtifact.create).toHaveBeenCalledWith({
      data: { tagId, artifactId: branchId },
      select: { id: true },
    });
    expect(captureArtifactMetadataChange).toHaveBeenCalledExactlyOnceWith({
      tx: db,
      organizationId,
      artifactId: branchId,
      actorType: ArtifactActivityActorType.User,
      actorId: actor.userId,
      action: ArtifactActivityAction.FieldChange,
      field: SessionMetadataActivityField.Tag,
      before: null,
      after: tagId,
    });
  });

  it("records Document tag edits through the same artifact receipt path", async () => {
    const db = branchTagDb(1, ArtifactType.Document);
    mockWithDbAll(db);

    await tagService.applyTag(
      tagId,
      TagEntityType.Artifact,
      branchId,
      organizationId,
      actor
    );

    expect(captureArtifactMetadataChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ artifactId: branchId, after: tagId })
    );
  });

  it("records one removal and none when the relation was already absent", async () => {
    const db = branchTagDb();
    mockWithDbAll(db);

    await tagService.removeTag(
      tagId,
      TagEntityType.Artifact,
      branchId,
      organizationId,
      actor
    );

    expect(captureArtifactMetadataChange).toHaveBeenCalledExactlyOnceWith({
      tx: db,
      organizationId,
      artifactId: branchId,
      actorType: ArtifactActivityActorType.User,
      actorId: actor.userId,
      action: ArtifactActivityAction.FieldChange,
      field: SessionMetadataActivityField.Tag,
      before: tagId,
      after: null,
    });

    vi.clearAllMocks();
    const absent = branchTagDb(0);
    mockWithDbAll(absent);
    await tagService.removeTag(
      tagId,
      TagEntityType.Artifact,
      branchId,
      organizationId,
      actor
    );
    expect(captureArtifactMetadataChange).not.toHaveBeenCalled();
    expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ artifactCount: 1 })
    );
  });

  it("does not record a duplicate add after the unique constraint rejects it", async () => {
    const db = branchTagDb();
    db.tagArtifact.create.mockRejectedValue(
      Object.assign(new Error("duplicate tag"), {
        code: "P2002",
        meta: { target: ["tagId", "artifactId"] },
      })
    );
    mockWithDbAll(db);

    await expect(
      tagService.applyTag(
        tagId,
        TagEntityType.Artifact,
        branchId,
        organizationId,
        actor
      )
      // ISS-12552: the duplicate reports that it applied nothing.
    ).resolves.toBe(false);

    expect(captureArtifactMetadataChange).not.toHaveBeenCalled();
  });

  it("attributes an API-key Branch edit to the owning account and agent kind", async () => {
    const db = branchTagDb();
    mockWithDbAll(db);

    await tagService.applyTag(
      tagId,
      TagEntityType.Artifact,
      branchId,
      organizationId,
      { userId: "key-owner-1", authMethod: "api_key" }
    );

    expect(captureArtifactMetadataChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        actorType: ArtifactActivityActorType.Agent,
        actorId: "key-owner-1",
        field: SessionMetadataActivityField.Tag,
      })
    );
  });

  it("rejects the tag mutation when its receipt fails", async () => {
    const db = branchTagDb();
    mockWithDbAll(db);
    const failure = new Error("receipt unavailable");
    captureArtifactMetadataChange.mockRejectedValueOnce(failure);

    await expect(
      tagService.applyTag(
        tagId,
        TagEntityType.Artifact,
        branchId,
        organizationId,
        actor
      )
    ).rejects.toBe(failure);
  });

  it("does not treat a receipt P2002 as an already-applied Branch tag", async () => {
    const db = branchTagDb();
    mockWithDbAll(db);
    const failure = Object.assign(new Error("activity receipt collision"), {
      code: "P2002",
      meta: { target: ["id"] },
    });
    captureArtifactMetadataChange.mockRejectedValueOnce(failure);

    await expect(
      tagService.applyTag(
        tagId,
        TagEntityType.Artifact,
        branchId,
        organizationId,
        actor
      )
    ).rejects.toBe(failure);
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifact
    ).not.toHaveBeenCalled();
  });

  it("rejects a Branch tag removal when its receipt fails", async () => {
    const db = branchTagDb();
    mockWithDbAll(db);
    const failure = new Error("receipt unavailable");
    captureArtifactMetadataChange.mockRejectedValueOnce(failure);

    await expect(
      tagService.removeTag(
        tagId,
        TagEntityType.Artifact,
        branchId,
        organizationId,
        actor
      )
    ).rejects.toBe(failure);
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifact
    ).not.toHaveBeenCalled();
  });
});
