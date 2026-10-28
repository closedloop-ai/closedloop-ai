import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: { select: { id: true, name: true } },
}));

vi.mock("@/app/branches/branch-product-eligibility-service", () => ({
  branchProductEligibilityService: { findByIds: vi.fn() },
}));

vi.mock("@/app/branches/branch-provider-fallback-service", () => ({
  branchProviderFallbackService: { findByIds: vi.fn() },
}));

import {
  HIDE_COMPLETED_DOCUMENT_STATUSES,
  HIDE_COMPLETED_ISSUE_STATUSES,
} from "@repo/api/src/types/artifact-hide-completed";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType } from "@repo/database";
import {
  ASSIGNED_ID,
  ASSIGNEE_ID,
  DEPLOYMENT_ID,
  ORGANIZATION_ID,
  ROOT_ID,
  VIEWER_USER_ID,
} from "@/__tests__/support/artifacts/assigned-artifact-tree.ids";
import { anchorHideCompleted } from "@/__tests__/support/artifacts/assigned-artifact-tree.sql-readers";
import {
  type AssignedTreeHarness,
  artifact,
  collectArtifactIds,
  createAssignedTreeHarness,
} from "@/__tests__/support/artifacts/assigned-artifact-tree.test-harness";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import { branchProviderFallbackService } from "@/app/branches/branch-provider-fallback-service";
import { assignedArtifactTreeService } from "./assigned-artifact-tree-service";

/**
 * ISS-10471: hide-completed, a CASE over three status vocabularies rather than a
 * value list, which is why it is filed apart from the other facets.
 *
 * The asymmetry is the whole risk: an issue hides on its terminal statuses
 * while a document hides only on EXECUTED/OBSOLETE, because an APPROVED
 * document still awaits execution. Reaching for the domain-wide
 * `TERMINAL_DOCUMENT_STATUSES` — what every blocker check uses — deletes
 * approved work from the board.
 */

describe("assignedArtifactTreeService hide-completed facet", () => {
  let harness: AssignedTreeHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = createAssignedTreeHarness();
    vi.mocked(branchProductEligibilityService.findByIds).mockResolvedValue(
      new Map()
    );
    vi.mocked(branchProviderFallbackService.findByIds).mockResolvedValue(
      new Set()
    );
  });

  it("judges a null-subtype DOCUMENT by the document arm", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          status: DocumentStatus.Approved,
          subtype: null,
        }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          status: DocumentStatus.Executed,
          subtype: null,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { hideCompletedItems: true }
    );

    // `a.subtype` is nullable, so the issue arm's `a.subtype::text IN (...)`
    // evaluates NULL rather than false and the CASE falls through to the
    // document arm. Two reviewers split on whether that was correct or merely
    // untested — it is correct, and nothing asserted it until now.
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("keeps an APPROVED document visible while hiding an EXECUTED one", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          subtype: ArtifactSubtype.PRD,
          status: DocumentStatus.Approved,
        }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          subtype: ArtifactSubtype.PRD,
          status: DocumentStatus.Executed,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { hideCompletedItems: true }
    );

    // THE case this facet exists to get right. `APPROVED` is in the domain-wide
    // `TERMINAL_DOCUMENT_STATUSES` that every blocker check uses, so the natural
    // server implementation deletes approved work from the board. An approved
    // document still awaits execution and must stay.
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
    expect(anchorHideCompleted(harness.anchorCall())?.document).not.toContain(
      DocumentStatus.Approved
    );
  });

  it("hides an issue on its terminal statuses, which a document would survive", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          subtype: ArtifactSubtype.PRD,
          status: IssueStatus.Done,
        }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          subtype: ArtifactSubtype.FEATURE,
          status: IssueStatus.Done,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { hideCompletedItems: true }
    );

    // Same status, two subtypes, opposite outcomes — which is the asymmetry. A
    // single shared status list for both arms passes every other case here and
    // fails only this one.
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("judges a row stored as ISSUE by the issue rule, as the normalizer does", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          subtype: ArtifactSubtype.ISSUE,
          status: IssueStatus.Canceled,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { hideCompletedItems: true }
    );

    // `normalizeArtifactRowSubtype` folds the input-only alias to FEATURE on
    // read, so the client would judge this row as an issue. The query must
    // agree, or the same row is completed on one side and not the other.
    expect(collectArtifactIds(result)).toEqual([]);
  });

  it("binds each vocabulary to its own arm", async () => {
    harness.seedGraph([], []);

    await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { hideCompletedItems: true }
    );

    const emitted = anchorHideCompleted(harness.anchorCall());
    expect(emitted?.issue).toEqual([...HIDE_COMPLETED_ISSUE_STATUSES]);
    expect(emitted?.document).toEqual([...HIDE_COMPLETED_DOCUMENT_STATUSES]);
    // The issue arm must route BOTH spellings, because the read normalizer
    // folds one into the other.
    expect(emitted?.issueSubtypes).toEqual([
      ArtifactSubtype.FEATURE,
      ArtifactSubtype.ISSUE,
    ]);
    // Negated: the facet drops completed work. Without the `NOT` it would keep
    // only completed work, which no row-level assertion over one fixture can
    // tell apart from a correct filter over a different fixture.
    expect(emitted?.negated).toBe(true);
  });

  it("leaves a type the CASE cannot classify visible", async () => {
    harness.seedGraph(
      [
        artifact(DEPLOYMENT_ID, {
          assigneeId: ASSIGNEE_ID,
          type: ArtifactType.DEPLOYMENT,
          subtype: null,
          status: IssueStatus.Done,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { hideCompletedItems: true }
    );

    // `ELSE false`. The client's row-kind switch has no arm for a deployment
    // either, so hiding one would be the query deciding something no one did —
    // and its status happens to read DONE, which is the tempting wrong answer.
    expect(collectArtifactIds(result)).toEqual([DEPLOYMENT_ID]);
  });

  it("treats hideCompletedItems false as no narrowing at all", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          subtype: ArtifactSubtype.FEATURE,
          status: IssueStatus.Done,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { hideCompletedItems: false }
    );

    expect(anchorHideCompleted(harness.anchorCall())).toBeNull();
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });
});
