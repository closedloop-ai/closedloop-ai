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

import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import {
  ASSIGNED_ID,
  ASSIGNEE_ID,
  ORGANIZATION_ID,
  ROOT_ID,
  SECOND_ASSIGNED_ID,
  VIEWER_USER_ID,
} from "@/__tests__/support/artifacts/assigned-artifact-tree.ids";
import { anchorDateWindow } from "@/__tests__/support/artifacts/assigned-artifact-tree.sql-readers";
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
 * ISS-10471: the date window, the only facet that is a RANGE rather than set
 * membership.
 *
 * Two things here cannot be seen in the returned rows and so are asserted on the
 * emitted query: WHICH timestamp the window reads, and whether each end is
 * inclusive. Both produce a plausible set of rows when wrong.
 */
const WINDOW_FROM = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_TO = new Date("2026-06-30T23:59:59.999Z");
const AFTER_WINDOW = new Date("2026-07-15T00:00:00.000Z");

describe("assignedArtifactTreeService date window", () => {
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

  it("narrows on created_at, inclusive at both ends", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          createdAt: WINDOW_FROM,
        }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          createdAt: WINDOW_TO,
        }),
        artifact(SECOND_ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          createdAt: AFTER_WINDOW,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      {
        dateWindow: {
          field: ArtifactDateField.CreatedAt,
          from: WINDOW_FROM,
          to: WINDOW_TO,
        },
      }
    );

    // The two BOUNDARY rows are the test. A half-open upper bound drops the row
    // created exactly at `to`, which is the row a reader checking their filter
    // looks for first.
    const emitted = anchorDateWindow(harness.anchorCall());
    expect(emitted?.column).toBe("created_at");
    expect(emitted?.fromInclusive).toBe(true);
    expect(emitted?.toInclusive).toBe(true);
    expect(collectArtifactIds(result)).toEqual(
      expect.arrayContaining([ROOT_ID, ASSIGNED_ID])
    );
    expect(collectArtifactIds(result)).not.toContain(SECOND_ASSIGNED_ID);
  });

  it("reads updated_at when that field is asked for, not created_at", async () => {
    harness.seedGraph(
      [
        // In the window by `updated_at`, OUT of it by `created_at`.
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          createdAt: AFTER_WINDOW,
          updatedAt: WINDOW_FROM,
        }),
        // The mirror image, so neither column can satisfy both rows.
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          createdAt: WINDOW_FROM,
          updatedAt: AFTER_WINDOW,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      {
        dateWindow: {
          field: ArtifactDateField.UpdatedAt,
          from: WINDOW_FROM,
          to: WINDOW_TO,
        },
      }
    );

    expect(anchorDateWindow(harness.anchorCall())?.column).toBe("updated_at");
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("binds the window as instants, not as strings", async () => {
    harness.seedGraph([], []);

    await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      {
        dateWindow: {
          field: ArtifactDateField.CreatedAt,
          from: WINDOW_FROM,
          to: WINDOW_TO,
        },
      }
    );

    // A `Date` reaches Postgres as a timestamp; a pre-formatted string invites
    // the driver or the column to reinterpret it in another zone.
    const emitted = anchorDateWindow(harness.anchorCall());
    expect(emitted?.from).toBeInstanceOf(Date);
    expect(emitted?.from.toISOString()).toBe(WINDOW_FROM.toISOString());
    expect(emitted?.to.toISOString()).toBe(WINDOW_TO.toISOString());
  });

  it("issues no date predicate at all when no window is requested", async () => {
    harness.seedGraph(
      [artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, createdAt: AFTER_WINDOW })],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    expect(harness.anchorQueryText()).not.toContain("a.created_at >=");
    expect(anchorDateWindow(harness.anchorCall())).toBeNull();
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });
});
