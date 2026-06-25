import type { DocumentDetail } from "@repo/api/src/types/document";
import { describe, expect, test } from "vitest";
import { getLatestContentForAttachmentWarnings } from "../document-editor-scaffold";

const selectedHistoricalContent = "Historical version has no inline ref.";
const savedLatestContent =
  "Saved latest content references ![diagram](attachment://latest-only-image).";

function createDocumentDetail(
  overrides: Partial<DocumentDetail> = {}
): DocumentDetail {
  const now = new Date("2026-06-12T00:00:00.000Z");

  return {
    id: "document-1",
    organizationId: "org-1",
    projectId: "project-1",
    type: "FEATURE",
    title: "Inline image feature",
    slug: "FEA-1762",
    fileName: null,
    status: "DRAFT",
    priority: "MEDIUM",
    latestVersion: 3,
    latestVersionContent: savedLatestContent,
    createdById: "user-1",
    createdBy: null,
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    tokenUsage: null,
    repositorySnapshot: {
      createdAt: now.toISOString(),
      repositories: [],
      source: "none",
    },
    templateForType: null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
    version: {
      id: "version-1",
      documentId: "document-1",
      version: 1,
      content: selectedHistoricalContent,
      createdById: "user-1",
      createdAt: now,
    },
    ...overrides,
  };
}

describe("getLatestContentForAttachmentWarnings", () => {
  test("uses saved latest-version content while a historical version is selected", () => {
    expect(
      getLatestContentForAttachmentWarnings({
        currentVersion: 1,
        document: createDocumentDetail(),
        latestDraftContent: "Unsaved draft from a different selected version.",
      })
    ).toBe(savedLatestContent);
  });

  test("uses the current draft content while the latest version is selected", () => {
    const latestDraftContent =
      "Draft latest content references ![new](attachment://new-image).";

    expect(
      getLatestContentForAttachmentWarnings({
        currentVersion: 3,
        document: createDocumentDetail(),
        latestDraftContent,
      })
    ).toBe(latestDraftContent);
  });
});
