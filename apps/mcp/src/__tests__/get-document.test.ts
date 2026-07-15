import { Priority } from "@repo/api/src/types/common.js";
import {
  DocumentType,
  FeatureStatus,
  SnapshotSource,
} from "@repo/api/src/types/document.js";
import { describe, expect, it } from "vitest";
import { shapeGetDocumentPayload } from "../tools/get-document.js";

const baseVersion = {
  id: "ver-1",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdById: "user-1",
  content: "",
};

describe("shapeGetDocumentPayload", () => {
  it("exposes priority, fileName, assigneeId, assignee, approverId, approver and repositorySnapshot when present", () => {
    const fixture = {
      id: "doc-1",
      slug: "FEA-100",
      title: "My Feature",
      type: DocumentType.Feature,
      status: FeatureStatus.Triage,
      projectId: "project-1",
      priority: Priority.High,
      fileName: "my-feature.md",
      assigneeId: "019c2991-0bce-76bc-bc7e-a4750929f668",
      assignee: {
        id: "019c2991-0bce-76bc-bc7e-a4750929f668",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: null,
        avatarUrl: null,
      },
      approverId: "019c2991-0bce-76bc-bc7e-a4750929f669",
      approver: {
        id: "019c2991-0bce-76bc-bc7e-a4750929f669",
        email: "bob@example.com",
        firstName: "Bob",
        lastName: null,
        avatarUrl: null,
      },
      repositorySnapshot: {
        source: SnapshotSource.LoopSelection,
        repositories: [
          { fullName: "org/repo", role: "primary" as const, position: 0 },
        ],
      },
      latestVersion: 1,
      sortOrder: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: baseVersion,
    };

    const result = shapeGetDocumentPayload(fixture);

    expect(result.priority).toBe(Priority.High);
    expect(result.fileName).toBe("my-feature.md");
    expect(result.assigneeId).toBe("019c2991-0bce-76bc-bc7e-a4750929f668");
    expect(result.assignee).toEqual({
      id: "019c2991-0bce-76bc-bc7e-a4750929f668",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: null,
      avatarUrl: null,
    });
    expect(result.approverId).toBe("019c2991-0bce-76bc-bc7e-a4750929f669");
    expect(result.approver).toEqual({
      id: "019c2991-0bce-76bc-bc7e-a4750929f669",
      email: "bob@example.com",
      firstName: "Bob",
      lastName: null,
      avatarUrl: null,
    });
    expect(result.repositorySnapshot).toEqual({
      source: SnapshotSource.LoopSelection,
      repositories: [{ fullName: "org/repo", role: "primary", position: 0 }],
    });
  });

  it("returns null for priority, fileName, assigneeId, assignee, approverId, approver and repositorySnapshot when absent", () => {
    const fixture = {
      id: "doc-1",
      slug: "FEA-101",
      title: "Minimal Feature",
      type: DocumentType.Feature,
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: baseVersion,
    };

    const result = shapeGetDocumentPayload(fixture);

    expect(result.priority).toBeNull();
    expect(result.fileName).toBeNull();
    expect(result.assigneeId).toBeNull();
    expect(result.assignee).toBeNull();
    expect(result.approverId).toBeNull();
    expect(result.approver).toBeNull();
    expect(result.repositorySnapshot).toBeNull();
  });
});
