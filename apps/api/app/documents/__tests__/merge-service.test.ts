/**
 * Unit tests for documentMergeService.merge.
 *
 * All external dependencies (LLM, database, Liveblocks room deletion,
 * content sanitization) are mocked. The focus is the post-commit contract:
 * once the transaction (new version + secondary-artifact delete) has committed,
 * that commit is authoritative — a failure of the follow-up best-effort
 * Liveblocks room delete must NOT fail the merge request (FEA-3449). Instead it
 * is logged for follow-up cleanup, matching the codebase's post-commit
 * best-effort convention (e.g. retention-service's S3 purge).
 */
import type { Document } from "@repo/api/src/types/document";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/ai/server", () => ({
  escapeXmlClosingTags: (text: string) => text,
  generateText: vi.fn(),
  models: { sonnet: "sonnet" },
}));

vi.mock("@repo/database", () => {
  const tx = vi.fn();
  const withDbFn = Object.assign(vi.fn(), { tx });
  return { withDb: withDbFn };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../templates/service", () => ({
  documentTemplatesService: { findOrgTemplate: vi.fn() },
}));

vi.mock("../document-service", () => ({
  documentService: { findByIdSimple: vi.fn() },
}));

vi.mock("../document-version-service", () => ({
  documentVersionService: { getLatest: vi.fn() },
}));

vi.mock("../room-utils", () => ({
  deleteDocumentRoom: vi.fn(),
}));

vi.mock("../sanitize-content", () => ({
  sanitizeAndLog: (content: string) => content,
}));

import { generateText } from "@repo/ai/server";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { documentService } from "../document-service";
import { documentVersionService } from "../document-version-service";
import { documentMergeService } from "../merge-service";
import { deleteDocumentRoom } from "../room-utils";

const mockGenerateText = generateText as unknown as Mock;
const mockWithDbTx = (withDb as unknown as { tx: Mock }).tx;
const mockFindByIdSimple = documentService.findByIdSimple as unknown as Mock;
const mockGetLatest = documentVersionService.getLatest as unknown as Mock;
const mockDeleteDocumentRoom = deleteDocumentRoom as unknown as Mock;
const mockLogError = log.error as unknown as Mock;

const ORG_ID = "org-1";
const USER_ID = "user-1";
const PRIMARY_ID = "primary-doc";
const SECONDARY_ID = "secondary-doc";
const SECONDARY_SLUG = "secondary-slug";

// Only the fields merge() reads are populated; cast to the full Document shape.
function makeDoc(overrides: Record<string, unknown>): Document {
  return {
    id: "doc",
    organizationId: ORG_ID,
    projectId: "proj-1",
    type: "PRD",
    slug: "slug",
    latestVersion: 1,
    ...overrides,
  } as unknown as Document;
}

const primaryDoc = makeDoc({ id: PRIMARY_ID, slug: "primary-slug" });
const secondaryDoc = makeDoc({ id: SECONDARY_ID, slug: SECONDARY_SLUG });
const mergedDoc = makeDoc({
  id: PRIMARY_ID,
  slug: "primary-slug",
  latestVersion: 2,
});

describe("documentMergeService.merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFindByIdSimple.mockImplementation((id: string) => {
      if (id === PRIMARY_ID) {
        return primaryDoc;
      }
      if (id === SECONDARY_ID) {
        return secondaryDoc;
      }
      return null;
    });
    mockGetLatest.mockResolvedValue({ content: "some content" });
    mockGenerateText.mockResolvedValue({ text: "merged content" });
    // Commit succeeds: findUnique returns a detail row, so the tx returns ok.
    mockWithDbTx.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          documentDetail: {
            findUnique: vi.fn().mockResolvedValue({ latestVersion: 1 }),
            update: vi.fn().mockResolvedValue({}),
          },
          documentVersion: { create: vi.fn().mockResolvedValue({}) },
          artifact: { delete: vi.fn().mockResolvedValue({}) },
        })
    );
    mockDeleteDocumentRoom.mockResolvedValue(undefined);
  });

  it("merges, deletes the secondary room, and returns the updated primary", async () => {
    // Final findByIdSimple(primary) reflects the merged version.
    mockFindByIdSimple.mockImplementation((id: string) => {
      if (id === PRIMARY_ID) {
        return mergedDoc;
      }
      if (id === SECONDARY_ID) {
        return secondaryDoc;
      }
      return null;
    });

    const result = await documentMergeService.merge(
      PRIMARY_ID,
      SECONDARY_ID,
      ORG_ID,
      USER_ID
    );

    expect(result.ok).toBe(true);
    expect(mockDeleteDocumentRoom).toHaveBeenCalledWith(ORG_ID, SECONDARY_SLUG);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("still succeeds when the post-commit room delete throws (FEA-3449)", async () => {
    mockFindByIdSimple.mockImplementation((id: string) => {
      if (id === PRIMARY_ID) {
        return mergedDoc;
      }
      if (id === SECONDARY_ID) {
        return secondaryDoc;
      }
      return null;
    });
    mockDeleteDocumentRoom.mockRejectedValue(new Error("Liveblocks down"));

    const result = await documentMergeService.merge(
      PRIMARY_ID,
      SECONDARY_ID,
      ORG_ID,
      USER_ID
    );

    // The DB commit is authoritative: the merge succeeds despite the room
    // outage, rather than surfacing a 500 for an already-committed merge.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(PRIMARY_ID);
    }
    // The leaked room is logged for follow-up cleanup.
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError.mock.calls[0][1]).toMatchObject({
      organizationId: ORG_ID,
      secondaryDocumentId: SECONDARY_ID,
      secondarySlug: SECONDARY_SLUG,
    });
  });

  it("returns NotFound without deleting the room when the commit reports the detail row is gone", async () => {
    // Detail row deleted mid-merge: tx returns NotFound, so no room delete runs.
    mockWithDbTx.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          documentDetail: {
            findUnique: vi.fn().mockResolvedValue(null),
            update: vi.fn(),
          },
          documentVersion: { create: vi.fn() },
          artifact: { delete: vi.fn() },
        })
    );

    const result = await documentMergeService.merge(
      PRIMARY_ID,
      SECONDARY_ID,
      ORG_ID,
      USER_ID
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(Status.NotFound);
    }
    expect(mockDeleteDocumentRoom).not.toHaveBeenCalled();
  });
});
