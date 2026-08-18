import { TraceCommentTargetType } from "@repo/api/src/types/comment";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { ArtifactType } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const indexAfterCommit = vi.hoisted(() => vi.fn());
const removeAfterCommit = vi.hoisted(() => vi.fn());

vi.mock("@/app/search/search-index-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/search/search-index-service")
  >("@/app/search/search-index-service");
  return {
    ...actual,
    searchIndexService: { indexAfterCommit, removeAfterCommit },
  };
});

import {
  indexTraceCommentAfterCommit,
  removeTraceCommentAfterCommit,
} from "./trace-comment-search-index";

const AT = new Date("2026-07-24T00:00:00.000Z");

describe("indexTraceCommentAfterCommit (FEA-3930 write hook)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("indexes a session-anchored comment with the session anchor type for routing", () => {
    indexTraceCommentAfterCommit({
      organizationId: "org-1",
      commentId: "c1",
      body: "this needs a fix",
      authorId: "author-3",
      anchorArtifactId: "session-artifact-1",
      targetType: TraceCommentTargetType.Session,
      updatedAt: AT,
    });

    expect(indexAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: SearchEntityType.Comment,
        entityId: "c1",
        body: "this needs a fix",
        assigneeId: "author-3",
        // Anchor artifact TYPE (session) rides in entitySubtype; anchor id in
        // anchorEntityId — together they build the session deep link.
        entitySubtype: ArtifactType.SESSION,
        anchorEntityId: "session-artifact-1",
      })
    );
  });

  it("indexes a branch-anchored comment with the branch anchor type", () => {
    indexTraceCommentAfterCommit({
      organizationId: "org-1",
      commentId: "c2",
      body: "branch note",
      authorId: "author-4",
      anchorArtifactId: "branch-artifact-2",
      targetType: TraceCommentTargetType.Branch,
      updatedAt: AT,
    });

    expect(indexAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        entitySubtype: ArtifactType.BRANCH,
        anchorEntityId: "branch-artifact-2",
      })
    );
  });
});

describe("removeTraceCommentAfterCommit (FEA-3930 delete hook)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes the comment's projection row by its search key", () => {
    removeTraceCommentAfterCommit({ organizationId: "org-1", commentId: "c9" });
    expect(removeAfterCommit).toHaveBeenCalledWith({
      organizationId: "org-1",
      entityType: SearchEntityType.Comment,
      entityId: "c9",
    });
  });
});
