import type { DocumentDetail } from "@repo/api/src/types/document";
import { describe, expect, test } from "vitest";
import {
  getLatestContentForAttachmentWarnings,
  resolveActiveRoomId,
} from "../document-editor-scaffold";

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

describe("resolveActiveRoomId (FEA-2404 Liveblocks mount-race gate)", () => {
  const roomId = "org-1:FEA-1762";

  test("does not connect the room while the current user is still loading", () => {
    expect(
      resolveActiveRoomId({
        liveblocksRoomId: roomId,
        isUserLoading: true,
        hasCurrentUser: false,
      })
    ).toBeNull();
  });

  test("does not connect the room when there is no current user yet", () => {
    expect(
      resolveActiveRoomId({
        liveblocksRoomId: roomId,
        isUserLoading: false,
        hasCurrentUser: false,
      })
    ).toBeNull();
  });

  test("connects the room once the user/org context is ready", () => {
    expect(
      resolveActiveRoomId({
        liveblocksRoomId: roomId,
        isUserLoading: false,
        hasCurrentUser: true,
      })
    ).toBe(roomId);
  });

  test("stays room-less when the artifact has no room even if ready", () => {
    expect(
      resolveActiveRoomId({
        liveblocksRoomId: null,
        isUserLoading: false,
        hasCurrentUser: true,
      })
    ).toBeNull();
  });
});
