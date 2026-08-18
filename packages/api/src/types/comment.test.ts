import { describe, expect, it } from "vitest";
import {
  branchTraceCommentCollectionQuerySchema,
  DocumentThreadAnchorStatus,
  resolveAnchorStatusKernel,
  TraceCommentSurface,
} from "./comment.js";

describe("branchTraceCommentCollectionQuerySchema", () => {
  it("preserves omission and accepts only Branch detail surfaces", () => {
    expect(branchTraceCommentCollectionQuerySchema.parse({})).toEqual({});
    expect(
      branchTraceCommentCollectionQuerySchema.parse({
        surface: TraceCommentSurface.BranchTimeline,
      })
    ).toEqual({ surface: TraceCommentSurface.BranchTimeline });
    expect(
      branchTraceCommentCollectionQuerySchema.safeParse({
        surface: TraceCommentSurface.SessionDetail,
      }).success
    ).toBe(false);
  });
});

describe("resolveAnchorStatusKernel", () => {
  it("returns the explicit validated anchorStatus when present, ignoring anchorPreview", () => {
    expect(
      resolveAnchorStatusKernel({
        anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel,
        anchorPreview: { some: "preview" },
      })
    ).toBe(DocumentThreadAnchorStatus.ArtifactLevel);

    expect(
      resolveAnchorStatusKernel({
        anchorStatus: DocumentThreadAnchorStatus.Floating,
        anchorPreview: undefined,
      })
    ).toBe(DocumentThreadAnchorStatus.Floating);

    expect(
      resolveAnchorStatusKernel({
        anchorStatus: DocumentThreadAnchorStatus.Anchored,
        anchorPreview: undefined,
      })
    ).toBe(DocumentThreadAnchorStatus.Anchored);
  });

  it("ignores an invalid explicit anchorStatus and falls through to the anchorPreview inference", () => {
    expect(
      resolveAnchorStatusKernel({
        anchorStatus: "not-a-status",
        anchorPreview: { some: "preview" },
      })
    ).toBe(DocumentThreadAnchorStatus.Anchored);

    expect(
      resolveAnchorStatusKernel({
        anchorStatus: "not-a-status",
        anchorPreview: undefined,
      })
    ).toBeNull();
  });

  it("infers Anchored when anchorPreview is set (any defined value) and no explicit status", () => {
    expect(
      resolveAnchorStatusKernel({
        anchorStatus: undefined,
        anchorPreview: { row: 1 },
      })
    ).toBe(DocumentThreadAnchorStatus.Anchored);

    // A defined-but-empty preview still counts as "set".
    expect(
      resolveAnchorStatusKernel({
        anchorStatus: undefined,
        anchorPreview: {},
      })
    ).toBe(DocumentThreadAnchorStatus.Anchored);
  });

  it("returns the neutral null result when there is no explicit status and no anchorPreview", () => {
    expect(
      resolveAnchorStatusKernel({
        anchorStatus: undefined,
        anchorPreview: undefined,
      })
    ).toBeNull();
  });
});
