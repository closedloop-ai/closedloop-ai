import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { artifactListGroupPatch } from "@repo/app/artifacts/components/artifact-list";
import { ARTIFACT_GROUP_NO_VALUE } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-grouping";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it, vi } from "vitest";

const handlers = {
  onUpdateAssignee: vi.fn(),
  onUpdateStatus: vi.fn(),
  onUpdatePriority: vi.fn(),
  teamMembers: [{ id: "actual-owner", name: "Ada" }],
};
describe("production grouping write contracts", () => {
  it("clears an assignee using the actual unassigned group key, never persisting a display label", () => {
    expect(
      artifactListGroupPatch(
        createMockDocument(),
        "owner",
        ARTIFACT_GROUP_NO_VALUE,
        handlers
      )
    ).toEqual({ assigneeId: null });
  });
  it("writes an actual owner ID and rejects a display name", () => {
    expect(
      artifactListGroupPatch(
        createMockDocument(),
        "owner",
        "actual-owner",
        handlers
      )
    ).toEqual({ assigneeId: "actual-owner" });
    expect(
      artifactListGroupPatch(createMockDocument(), "owner", "Ada", handlers)
    ).toBeNull();
  });
  it("maps universal stage destination to permitted subtype raw status", () => {
    const document = createMockDocument({
      type: DocumentType.ImplementationPlan,
      status: DocumentStatus.Draft,
    });
    expect(
      artifactListGroupPatch(
        document,
        "status",
        ARTIFACT_STATUS_ROOT.Done,
        handlers
      )
    ).toEqual({ status: DocumentStatus.Approved });
  });
  it("refuses unavailable destinations and missing write handlers", () => {
    expect(
      artifactListGroupPatch(
        createMockDocument(),
        "approval",
        "Complete",
        handlers
      )
    ).toBeNull();
    expect(
      artifactListGroupPatch(
        createMockDocument(),
        "owner",
        ARTIFACT_GROUP_NO_VALUE,
        {}
      )
    ).toBeNull();
  });
  it("writes model priorities and rejects display-only destinations", () => {
    const issue = createMockDocument({ type: DocumentType.Feature });
    expect(
      artifactListGroupPatch(issue, "priority", Priority.High, handlers)
    ).toEqual({ priority: Priority.High });
    expect(
      artifactListGroupPatch(
        issue,
        "priority",
        ARTIFACT_GROUP_NO_VALUE,
        handlers
      )
    ).toEqual({ priority: null });
    expect(
      artifactListGroupPatch(issue, "priority", "P0", handlers)
    ).toBeNull();
    expect(
      artifactListGroupPatch(issue, "priority", Priority.High, {})
    ).toBeNull();
  });
  it("keeps the exact status when the destination lane is the current root", () => {
    const issue = createMockDocument({
      type: DocumentType.Feature,
      status: IssueStatus.Backlog,
    });
    expect(
      artifactListGroupPatch(
        issue,
        "status",
        ARTIFACT_STATUS_ROOT.Todo,
        handlers
      )
    ).toEqual({});
  });
});
