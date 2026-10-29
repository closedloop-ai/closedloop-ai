import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { AssignmentEntityType } from "@repo/collaboration/server/inbox-notifications";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchAssignmentNotification: vi.fn(),
  updateAssigneeManyAfterCommit: vi.fn(),
}));
vi.mock("@/app/search/search-index-service", () => ({
  searchIndexService: {
    updateAssigneeManyAfterCommit: mocks.updateAssigneeManyAfterCommit,
  },
}));
vi.mock("@/lib/assignment-notifications", () => ({
  dispatchAssignmentNotification: mocks.dispatchAssignmentNotification,
}));

import { emitBatchDocumentAssigneeSideEffects } from "./document-assignee-batch-side-effects";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const CHANGED_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const CHANGE = {
  artifactId: CHANGED_ID,
  before: null,
  name: "Owned artifact",
  slug: "owned-artifact",
  subtype: "PRD",
};

beforeEach(() => vi.clearAllMocks());

describe("batch document owner side effects", () => {
  it("refreshes only committed changed IDs", () => {
    emitBatchDocumentAssigneeSideEffects({
      actorUserId: ACTOR_ID,
      organizationId: ORGANIZATION_ID,
      assigneeId: OWNER_ID,
      changes: [CHANGE],
    });
    expect(mocks.updateAssigneeManyAfterCommit).toHaveBeenCalledWith(
      {
        organizationId: ORGANIZATION_ID,
        entityType: SearchEntityType.Document,
      },
      [CHANGED_ID],
      OWNER_ID
    );
    emitBatchDocumentAssigneeSideEffects({
      actorUserId: ACTOR_ID,
      organizationId: ORGANIZATION_ID,
      assigneeId: OWNER_ID,
      changes: [],
    });
    expect(mocks.updateAssigneeManyAfterCommit).toHaveBeenCalledTimes(1);
  });

  it("dispatches the same per-item assignment notification as a single update", () => {
    emitBatchDocumentAssigneeSideEffects({
      actorUserId: ACTOR_ID,
      organizationId: ORGANIZATION_ID,
      assigneeId: OWNER_ID,
      changes: [CHANGE],
    });
    expect(mocks.dispatchAssignmentNotification).toHaveBeenCalledWith({
      previousAssigneeId: null,
      newAssigneeId: OWNER_ID,
      actorUserId: ACTOR_ID,
      organizationId: ORGANIZATION_ID,
      entityType: AssignmentEntityType.Artifact,
      entityTitle: "Owned artifact",
      entityUrl: "/documents/owned-artifact",
      subjectId: CHANGED_ID,
    });
  });

  it("does not turn a committed write into a 500 when projection scheduling throws", () => {
    mocks.updateAssigneeManyAfterCommit.mockImplementation(() => {
      throw new Error("projection unavailable");
    });
    expect(() =>
      emitBatchDocumentAssigneeSideEffects({
        actorUserId: ACTOR_ID,
        organizationId: ORGANIZATION_ID,
        assigneeId: OWNER_ID,
        changes: [CHANGE],
      })
    ).not.toThrow();
  });

  it("keeps later committed-item side effects when one notification throws", () => {
    mocks.dispatchAssignmentNotification.mockImplementation(() => {
      throw new Error("notification unavailable");
    });

    expect(() =>
      emitBatchDocumentAssigneeSideEffects({
        actorUserId: ACTOR_ID,
        organizationId: ORGANIZATION_ID,
        assigneeId: OWNER_ID,
        changes: [CHANGE],
      })
    ).not.toThrow();
    expect(mocks.updateAssigneeManyAfterCommit).toHaveBeenCalledTimes(1);
  });
});
