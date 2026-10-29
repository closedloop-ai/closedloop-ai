import assert from "node:assert/strict";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { describe, test } from "vitest";
import {
  branchLifecycleEventsForBranchLink,
  branchLifecycleEventsForPrLink,
} from "../src/main/database/branch-lifecycle-events.js";

describe("desktop branch lifecycle event projection", () => {
  test("maps branch write and read-only relations to their boundary kinds", () => {
    assert.deepEqual(
      branchLifecycleEventsForBranchLink({
        linkId: "link-1",
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-08-20T10:00:00.000Z",
      }),
      [
        {
          kind: BranchLifecycleBoundaryKind.BranchWrite,
          evidenceId: "desktop-artifact-link:link-1",
          observedAt: "2026-08-20T10:00:00.000Z",
        },
      ]
    );
    assert.deepEqual(
      branchLifecycleEventsForBranchLink({
        relation: ArtifactRefRelation.Workspace,
      }),
      [{ kind: BranchLifecycleBoundaryKind.ReadOnlyReference }]
    );
  });

  test("omits non-lifecycle branch relations", () => {
    assert.deepEqual(
      branchLifecycleEventsForBranchLink({ relation: null }),
      []
    );
    assert.deepEqual(
      branchLifecycleEventsForBranchLink({
        relation: ArtifactRefRelation.Reviewed,
      }),
      [{ kind: BranchLifecycleBoundaryKind.ReadOnlyReference }]
    );
  });

  test("distinguishes raised PRs from review feedback and read-only reviews", () => {
    assert.deepEqual(
      branchLifecycleEventsForPrLink({ relation: ArtifactRefRelation.Created }),
      [{ kind: BranchLifecycleBoundaryKind.PrRaised }]
    );
    assert.deepEqual(
      branchLifecycleEventsForPrLink({
        relation: ArtifactRefRelation.Reviewed,
        method: ArtifactRefMethod.PrReviewFeedbackCommand,
      }),
      [{ kind: BranchLifecycleBoundaryKind.ReviewFeedback }]
    );
    assert.deepEqual(
      branchLifecycleEventsForPrLink({
        relation: ArtifactRefRelation.Reviewed,
        method: ArtifactRefMethod.PrReviewCommand,
      }),
      [{ kind: BranchLifecycleBoundaryKind.ReadOnlyReference }]
    );
    assert.deepEqual(
      branchLifecycleEventsForPrLink({
        relation: ArtifactRefRelation.Workspace,
      }),
      []
    );
  });

  test("omits malformed timestamps and empty evidence ids", () => {
    assert.deepEqual(
      branchLifecycleEventsForPrLink({
        linkId: "",
        relation: ArtifactRefRelation.Created,
        observedAt: "not-a-date",
      }),
      [{ kind: BranchLifecycleBoundaryKind.PrRaised }]
    );
  });
});
