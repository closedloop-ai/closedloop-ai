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
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import type { PriorityFilterValue } from "@repo/api/src/types/priority-filter";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import {
  ASSIGNED_ID,
  ASSIGNEE_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  ROOT_ID,
  SECOND_ASSIGNED_ID,
  VIEWER_USER_ID,
} from "@/__tests__/support/artifacts/assigned-artifact-tree.ids";
import {
  anchorLimit,
  anchorOrderBy,
  anchorPriorityFilter,
  anchorProjectFilter,
  anchorStatusFilter,
  anchorTagFilter,
} from "@/__tests__/support/artifacts/assigned-artifact-tree.sql-readers";
import {
  type AssignedTreeHarness,
  artifact,
  collectArtifactIds,
  createAssignedTreeHarness,
  link,
} from "@/__tests__/support/artifacts/assigned-artifact-tree.test-harness";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import { branchProviderFallbackService } from "@/app/branches/branch-provider-fallback-service";
import { MAX_TREE_ANCHORS } from "./assigned-artifact-tree-anchors";
import { assignedArtifactTreeService } from "./assigned-artifact-tree-service";

/**
 * ISS-10471: the facets that narrow on a VALUE the artifacts table holds —
 * status, priority, tags and project.
 *
 * Every case asserts the EMITTED QUERY rather than the fixture's rows. The
 * anchor cap is what makes the facets worth having, so a post-fetch
 * `.filter()` would satisfy a row-level assertion while still spending the
 * whole budget on rows the caller excluded.
 */
const OTHER_PROJECT_ID = "0c0c0c0c-0c0c-7c0c-8c0c-0c0c0c0c0c0c";
const TAG_ID = "0a0a0a0a-0a0a-7a0a-8a0a-0a0a0a0a0a0a";
const OTHER_TAG_ID = "0b0b0b0b-0b0b-7b0b-8b0b-0b0b0b0b0b0b";

describe("assignedArtifactTreeService anchor value filters", () => {
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

  it("narrows the anchor predicate in the query when a status is requested", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          status: IssueStatus.Todo,
        }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          status: IssueStatus.Done,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { status: [IssueStatus.Todo] }
    );

    expect(anchorStatusFilter(harness.anchorCall())).toEqual([
      IssueStatus.Todo,
    ]);
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("issues no status predicate at all when none is requested", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          status: IssueStatus.Todo,
        }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          status: IssueStatus.Done,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    // Omission narrows NOTHING — not a default set, and not an empty `IN ()`.
    expect(harness.anchorQueryText()).not.toContain("a.status");
    expect(anchorStatusFilter(harness.anchorCall())).toBeNull();
    expect(collectArtifactIds(result)).toEqual(
      expect.arrayContaining([ROOT_ID, ASSIGNED_ID])
    );
  });

  it("accepts statuses from both lifecycle vocabularies in one request", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          status: DocumentStatus.Draft,
        }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          status: IssueStatus.Todo,
        }),
        artifact(SECOND_ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          status: IssueStatus.Canceled,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { status: [DocumentStatus.Draft, IssueStatus.Todo] }
    );

    // A tree holds both artifact kinds, so narrowing it by one vocabulary alone
    // would make the other kind unreachable through the same filter.
    expect(collectArtifactIds(result)).toEqual(
      expect.arrayContaining([ROOT_ID, ASSIGNED_ID])
    );
    expect(collectArtifactIds(result)).not.toContain(SECOND_ASSIGNED_ID);
  });

  it("dedupes repeated statuses before they reach the IN list", async () => {
    harness.seedGraph([], []);

    await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { status: [IssueStatus.Todo, IssueStatus.Todo, IssueStatus.InProgress] }
    );

    // The vocabulary is closed, so deduping bounds the `IN` list at its size
    // however repetitive the query string was.
    expect(anchorStatusFilter(harness.anchorCall())).toEqual([
      IssueStatus.Todo,
      IssueStatus.InProgress,
    ]);
  });

  it("narrows the ANCHORS without pruning the chains they hang from", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { status: DocumentStatus.Approved }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          status: IssueStatus.Todo,
        }),
      ],
      // PRODUCES runs source -> target, so the APPROVED document is the parent.
      [link(ROOT_ID, ASSIGNED_ID)]
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { status: [IssueStatus.Todo] }
    );

    // The parent is an APPROVED document the filter excludes, and it is still
    // here: the breadcrumb is what makes the anchor legible, so the filter
    // decides which work is ADMITTED, never which context it keeps.
    expect(collectArtifactIds(result)).toEqual([ROOT_ID, ASSIGNED_ID]);
  });

  it("narrows on priority in the query", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          priority: Priority.Urgent,
        }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          priority: Priority.Low,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { priority: [Priority.Urgent] }
    );

    expect(anchorPriorityFilter(harness.anchorCall())).toEqual({
      members: [Priority.Urgent],
      includesUnset: false,
      combinator: null,
    });
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("selects rows holding NO priority when the unset token is asked for", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, priority: null }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          priority: Priority.High,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { priority: [PRIORITY_UNSET_VALUE] }
    );

    // `IS NULL`, not a value in the `IN` list — null is a state a user filters,
    // never a stand-in for MEDIUM (ISS-9665), and no value list matches it.
    expect(anchorPriorityFilter(harness.anchorCall())).toEqual({
      members: [],
      includesUnset: true,
      combinator: null,
    });
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("ORs the member and unset arms when both are asked for", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, priority: null }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          priority: Priority.High,
        }),
        artifact(SECOND_ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          priority: Priority.Low,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { priority: [Priority.High, PRIORITY_UNSET_VALUE] }
    );

    expect(anchorPriorityFilter(harness.anchorCall())?.combinator).toBe("OR");
    // Either arm alone would drop half of this fixture, so the test fails if
    // the helper stops ORing them.
    expect(collectArtifactIds(result)).toEqual(
      expect.arrayContaining([ROOT_ID, ASSIGNED_ID])
    );
    expect(collectArtifactIds(result)).not.toContain(SECOND_ASSIGNED_ID);
  });

  it("states the sort keys and the cap", async () => {
    // Neither is observable from a row set: a fixture under the cap returns the
    // same rows with no `LIMIT` at all, and the ids a fixture happens to carry
    // can agree with a tiebreak the query never stated. `id DESC` is what lets
    // the partial index serve the sort as an ordered scan.
    harness.seedGraph([], []);
    await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      {}
    );
    expect(anchorOrderBy(harness.anchorCall())).toEqual({
      createdAt: "DESC",
      id: "DESC",
    });
    expect(anchorLimit(harness.anchorCall())).toBe(MAX_TREE_ANCHORS + 1);
  });

  it("introduces all SEVEN facet fragments with AND, never OR", async () => {
    harness.seedGraph([], []);

    await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      {
        dateWindow: {
          field: ArtifactDateField.CreatedAt,
          from: new Date("2026-07-01T00:00:00.000Z"),
          to: new Date("2026-07-31T00:00:00.000Z"),
        },
        favoritesOnly: true,
        hideCompletedItems: true,
        priority: [Priority.Urgent],
        projectIds: [PROJECT_ID],
        status: [IssueStatus.Todo],
        tagIds: [TAG_ID],
      }
    );

    // A facet fragment opening with OR would widen the predicate past the
    // organization and assignee gates, which no row-level fixture assertion can
    // see. All seven are asserted because five carried no such check.
    const text = harness.anchorQueryText();
    // Six markers for seven facets: tags and favorites both emit `AND EXISTS`.
    for (const introduced of [
      "AND a.status IN",
      "AND (a.priority",
      "AND EXISTS",
      "AND a.project_id IN",
      "AND NOT (",
      "AND a.created_at >=",
    ]) {
      expect(text).toContain(introduced);
      expect(text).not.toContain(introduced.replace("AND ", "OR "));
    }
  });

  it("composes the status and priority facets as AND", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, {
          assigneeId: ASSIGNEE_ID,
          status: IssueStatus.Todo,
          priority: Priority.Urgent,
        }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          status: IssueStatus.Todo,
          priority: Priority.Low,
        }),
        artifact(SECOND_ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          status: IssueStatus.Done,
          priority: Priority.Urgent,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { priority: [Priority.Urgent], status: [IssueStatus.Todo] }
    );

    // Each facet narrows; two facets narrow further. A row satisfying only one
    // of them is exactly what an OR between facets would wrongly admit.
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("issues no priority predicate at all when none is requested", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, priority: null }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          priority: Priority.High,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    expect(harness.anchorQueryText()).not.toContain("a.priority");
    expect(anchorPriorityFilter(harness.anchorCall())).toBeNull();
    expect(collectArtifactIds(result)).toEqual(
      expect.arrayContaining([ROOT_ID, ASSIGNED_ID])
    );
  });

  it("refuses a requested priority selection it cannot narrow on", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, priority: null }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          priority: Priority.High,
        }),
      ],
      []
    );

    // Off-vocabulary, and not the unset token: the one state where an ASKED-FOR
    // facet resolves to no SQL arm. Unreachable past the route's
    // `z.enum(priorityFilterValues)`, so it is constructed here — the fail-open
    // it used to produce (no predicate at all, hence every assigned row for a
    // caller who asked to narrow) is why the state is refused rather than
    // widened.
    await expect(
      assignedArtifactTreeService.getAssignedArtifactTree(
        ASSIGNEE_ID,
        ORGANIZATION_ID,
        VIEWER_USER_ID,
        { priority: ["NOT_A_PRIORITY" as PriorityFilterValue] }
      )
    ).rejects.toThrow("resolved to no SQL arm");
  });

  it("narrows on tags with an indexed EXISTS, admitting a row on ANY selected tag", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, tagIds: [TAG_ID] }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          tagIds: [OTHER_TAG_ID],
        }),
        artifact(SECOND_ASSIGNED_ID, { assigneeId: ASSIGNEE_ID, tagIds: [] }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { tagIds: [TAG_ID, OTHER_TAG_ID] }
    );

    expect(anchorTagFilter(harness.anchorCall())).toEqual([
      TAG_ID,
      OTHER_TAG_ID,
    ]);
    // ANY, not ALL: each row carries exactly one of the two, and both are kept.
    expect(collectArtifactIds(result)).toEqual(
      expect.arrayContaining([ROOT_ID, ASSIGNED_ID])
    );
    expect(collectArtifactIds(result)).not.toContain(SECOND_ASSIGNED_ID);
  });

  it("admits a row carrying only ONE of several selected tags", async () => {
    harness.seedGraph(
      [artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, tagIds: [TAG_ID] })],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { tagIds: [TAG_ID, OTHER_TAG_ID] }
    );

    // An ALL predicate returns nothing here, which is the single case that
    // separates the two readings — `matchesTagFilter` in the browser is ANY, so
    // moving the question into the query must not change its answer.
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("correlates the EXISTS to the anchor row, not to the tag alone", async () => {
    harness.seedGraph([], []);

    await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { tagIds: [TAG_ID] }
    );

    // Without the correlation the subquery is satisfied by ANY tagged artifact
    // in the table, so every anchor passes and the facet narrows nothing while
    // still reading as implemented.
    expect(harness.anchorQueryText()).toContain("ta.artifact_id = a.id");
  });

  it("dedupes repeated tag ids before the IN list", async () => {
    harness.seedGraph([], []);

    await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { tagIds: [TAG_ID, TAG_ID, OTHER_TAG_ID] }
    );

    expect(anchorTagFilter(harness.anchorCall())).toEqual([
      TAG_ID,
      OTHER_TAG_ID,
    ]);
  });

  it("issues no tag predicate at all when none is requested", async () => {
    harness.seedGraph(
      [artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, tagIds: [] })],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    expect(harness.anchorQueryText()).not.toContain("tag_artifacts");
    expect(anchorTagFilter(harness.anchorCall())).toBeNull();
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("narrows on project in the query", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          projectId: OTHER_PROJECT_ID,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { projectIds: [PROJECT_ID] }
    );

    expect(anchorProjectFilter(harness.anchorCall())).toEqual([PROJECT_ID]);
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("admits every selected project, not just the first", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID }),
        artifact(ASSIGNED_ID, {
          assigneeId: ASSIGNEE_ID,
          projectId: OTHER_PROJECT_ID,
        }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { projectIds: [PROJECT_ID, OTHER_PROJECT_ID] }
    );

    // A predicate that bound only one element of the list would pass the
    // single-project case above and fail only here.
    expect(collectArtifactIds(result)).toEqual(
      expect.arrayContaining([ROOT_ID, ASSIGNED_ID])
    );
  });

  it("does NOT admit a project-less artifact through the project facet", async () => {
    harness.seedGraph(
      [
        artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID }),
        artifact(ASSIGNED_ID, { assigneeId: ASSIGNEE_ID, projectId: null }),
      ],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { projectIds: [PROJECT_ID] }
    );

    // `a.project_id IN (...)` is NULL-rejecting, and that is the shape both
    // existing project filters have — "project-less" is a separate dimension in
    // this repo, never a member of the id list. Asserted so the behaviour is a
    // recorded consequence rather than a surprise, and so adding an unset arm
    // later has to come here and say so.
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("dedupes repeated project ids before the IN list", async () => {
    harness.seedGraph([], []);

    await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { projectIds: [PROJECT_ID, PROJECT_ID, OTHER_PROJECT_ID] }
    );

    expect(anchorProjectFilter(harness.anchorCall())).toEqual([
      PROJECT_ID,
      OTHER_PROJECT_ID,
    ]);
  });

  it("keeps the project and tag id lists distinct when both are active", async () => {
    harness.seedGraph(
      [artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, tagIds: [TAG_ID] })],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID,
      { projectIds: [PROJECT_ID], tagIds: [TAG_ID] }
    );

    // Both facets bind bare uuids, so a reader that took every bound uuid would
    // report each facet as holding the other's ids too.
    expect(anchorProjectFilter(harness.anchorCall())).toEqual([PROJECT_ID]);
    expect(anchorTagFilter(harness.anchorCall())).toEqual([TAG_ID]);
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });

  it("issues no project predicate at all when none is requested", async () => {
    harness.seedGraph(
      [artifact(ROOT_ID, { assigneeId: ASSIGNEE_ID, projectId: null })],
      []
    );

    const result = await assignedArtifactTreeService.getAssignedArtifactTree(
      ASSIGNEE_ID,
      ORGANIZATION_ID,
      VIEWER_USER_ID
    );

    // Omission narrows nothing — including the project-less row the facet
    // cannot select.
    expect(harness.anchorQueryText()).not.toContain("a.project_id");
    expect(anchorProjectFilter(harness.anchorCall())).toBeNull();
    expect(collectArtifactIds(result)).toEqual([ROOT_ID]);
  });
});
