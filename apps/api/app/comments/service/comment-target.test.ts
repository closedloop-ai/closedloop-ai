import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  CommentSurface,
  CommentTargetType,
  ThreadSource,
} from "@repo/api/src/types/comment";
import { CommentPolicyKey } from "@repo/api/src/types/comment-capabilities";
import { Result } from "@repo/api/src/types/result";
import { describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({ withDb: vi.fn() }));

vi.mock("@repo/database", () => ({ withDb: databaseMocks.withDb }));

import {
  CommentArtifactType,
  commentArtifactTypeFor,
  commentPolicyKeyFor,
  commentTargetTypeFor,
  defaultCommentSurface,
  isSurfaceOnArtifactType,
  resolveCommentTarget,
} from "./comment-target";

describe("document comment targets (PLN-2187 T-1.3)", () => {
  it("maps a document to its target type and default surface", () => {
    expect(commentTargetTypeFor(CommentArtifactType.Document)).toBe(
      CommentTargetType.Document
    );
    expect(defaultCommentSurface(CommentArtifactType.Document)).toBe(
      CommentSurface.DocumentDetail
    );
  });

  it("maps every target type back to the artifact type it came from", () => {
    for (const artifactType of Object.values(CommentArtifactType)) {
      expect(commentArtifactTypeFor(commentTargetTypeFor(artifactType))).toBe(
        artifactType
      );
    }
    for (const targetType of Object.values(CommentTargetType)) {
      expect(commentTargetTypeFor(commentArtifactTypeFor(targetType))).toBe(
        targetType
      );
    }
  });

  it("places every surface on exactly one artifact type", () => {
    for (const surface of Object.values(CommentSurface)) {
      const owners = Object.values(CommentArtifactType).filter((artifactType) =>
        isSurfaceOnArtifactType(surface, artifactType)
      );
      expect(owners).toHaveLength(1);
    }
  });

  it("gives native and synced Liveblocks document threads one policy", () => {
    expect(
      commentPolicyKeyFor(CommentArtifactType.Document, ThreadSource.Native)
    ).toBe(CommentPolicyKey.NativeDocument);
    expect(
      commentPolicyKeyFor(CommentArtifactType.Document, ThreadSource.Liveblocks)
    ).toBe(CommentPolicyKey.NativeDocument);
    expect(
      commentPolicyKeyFor(CommentArtifactType.Document, ThreadSource.Github)
    ).toBeNull();
  });

  it("lands each surface only on its own artifact type", () => {
    expect(
      isSurfaceOnArtifactType(
        CommentSurface.DocumentDetail,
        CommentArtifactType.Document
      )
    ).toBe(true);
    expect(
      isSurfaceOnArtifactType(
        CommentSurface.DocumentDetail,
        CommentArtifactType.Branch
      )
    ).toBe(false);
    expect(
      isSurfaceOnArtifactType(
        CommentSurface.BranchDetail,
        CommentArtifactType.Document
      )
    ).toBe(false);
    expect(
      isSurfaceOnArtifactType(
        CommentSurface.BranchTimeline,
        CommentArtifactType.Branch
      )
    ).toBe(true);
    expect(
      isSurfaceOnArtifactType(
        CommentSurface.SessionDetail,
        CommentArtifactType.Branch
      )
    ).toBe(false);
  });

  it("resolves a document, whose writes the unified requests gate (T-2.6)", async () => {
    databaseMocks.withDb.mockImplementation((run) =>
      run({
        artifact: {
          findFirst: () =>
            Promise.resolve({ id: "doc-1", type: ArtifactType.Document }),
        },
      })
    );

    await expect(
      resolveCommentTarget({ organizationId: "org-1", artifactId: "doc-1" })
    ).resolves.toEqual(
      Result.ok({
        organizationId: "org-1",
        artifactId: "doc-1",
        artifactType: CommentArtifactType.Document,
      })
    );
  });
});
