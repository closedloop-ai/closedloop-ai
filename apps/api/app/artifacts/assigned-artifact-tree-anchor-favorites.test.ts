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
  ASSIGNED_ID,
  ASSIGNEE_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  ROOT_ID,
  VIEWER_USER_ID,
} from "@/__tests__/support/artifacts/assigned-artifact-tree.ids";
import {
  anchorFavoritesUserId,
  anchorProjectFilter,
  anchorTagFilter,
} from "@/__tests__/support/artifacts/assigned-artifact-tree.sql-readers";
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
 * ISS-10471: the favorites facet, the only one scoped to the VIEWER_USER_ID rather than
 * to the tree's subject.
 *
 * Its own file because that distinction IS the thing under test: this route
 * serves any org member's tree, so a predicate scoped to `assigneeId` would
 * filter a reader's view by a stranger's bookmarks. The harness reports the
 * bound USER ID rather than a boolean, so the counterfactual is assertable.
 */
const TAG_ID = "0a0a0a0a-0a0a-7a0a-8a0a-0a0a0a0a0a0a";

describe("assignedArtifactTreeService favorites facet", () => {
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

  it("narrows to the VIEWER_USER_ID's favorites, never the assignee's", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          favoritedBy: [VIEWER_USER_ID],
        }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          favoritedBy: [ASSIGNEE_ID],
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { favoritesOnly: true }
    );

    // The counterfactual is the whole test: ASSIGNED_ID is favorited by the
    // ASSIGNEE and by nobody else, so a predicate scoped to `assigneeId` would
    // return it and drop ROOT_ID — passing an "a favorites clause exists" check
    // while showing the reader a stranger's bookmarks.
    expect(anchorFavoritesUserId(harness.anchorCall())).toBe(VIEWER_USER_ID);
    expect(anchorFavoritesUserId(harness.anchorCall())).not.toBe(ASSIGNEE_ID);
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("admits a row favorited by the viewer AND others", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          favoritedBy: [ASSIGNEE_ID, VIEWER_USER_ID],
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { favoritesOnly: true }
    );

    // `EXISTS` asks whether the viewer's row is PRESENT, not whether theirs is
    // the only one, so another user's favorite must not exclude it.
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("treats favoritesOnly false as no narrowing at all", async () => {
    harness.seedGraph(
      [artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, favoritedBy: [] })],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { favoritesOnly: false }
    );

    // An explicit `false` is the chip switched off, which is not "show me
    // nothing" — the boolean has no third state to encode.
    expect(harness.anchorQueryText()).not.toContain("favorite_artifacts");
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("issues no favorites predicate at all when omitted", async () => {
    harness.seedGraph(
      [artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, favoritedBy: [] })],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    expect(anchorFavoritesUserId(harness.anchorCall())).toBeNull();
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("correlates the favorites EXISTS to the anchor row, not to the user alone", async () => {
    harness.seedGraph([], []);

    await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { favoritesOnly: true }
    );

    // Without the correlation the subquery is satisfied by ANY favorite the
    // viewer holds, so every anchor passes and the facet narrows nothing while
    // still reading as implemented.
    expect(harness.anchorQueryText()).toContain("fa.artifact_id = a.id");
  });

  it("keeps the favorites, tag and project ids distinct when all three are active", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          tagIds: [TAG_ID],
          favoritedBy: [VIEWER_USER_ID],
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { favoritesOnly: true, projectIds: [PROJECT_ID], tagIds: [TAG_ID] }
    );

    // All three bind bare uuids into one statement, so a reader that took every
    // bound uuid would report each facet as holding the others' ids.
    expect(anchorFavoritesUserId(harness.anchorCall())).toBe(VIEWER_USER_ID);
    expect(anchorTagFilter(harness.anchorCall())).toEqual([TAG_ID]);
    expect(anchorProjectFilter(harness.anchorCall())).toEqual([PROJECT_ID]);
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });
});
