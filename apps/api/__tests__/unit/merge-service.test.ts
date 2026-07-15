/**
 * Unit tests for `documentMergeService`.
 *
 * Covers:
 *  - `merge` — the full merge flow:
 *      • Returns NotFound when primary or secondary document is missing.
 *      • Throws when documents are in different projects.
 *      • Throws when either document is a TEMPLATE.
 *      • Calls LLM with correct prompts (with and without template content).
 *      • Throws when LLM returns empty content.
 *      • Saves a new version on the primary and deletes the secondary artifact.
 *      • Calls deleteDocumentRoom for the secondary slug.
 *      • Returns NotFound when the primary detail row is missing during tx.
 *      • Returns the updated primary document on success.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => {
  const mockWithDb = Object.assign(vi.fn(), { tx: vi.fn() });
  return { withDb: mockWithDb };
});

vi.mock("@repo/ai/server", () => ({
  generateText: vi.fn(),
  models: { sonnet: "claude-sonnet" },
  // Use the real implementation so the XML-escaping assertions stay meaningful.
  escapeXmlClosingTags: (content: string) => content.replaceAll("</", "&lt;/"),
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    findByIdSimple: vi.fn(),
  },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getLatest: vi.fn(),
  },
}));

vi.mock("@/app/templates/service", () => ({
  documentTemplatesService: {
    findOrgTemplate: vi.fn(),
  },
}));

vi.mock("@/app/documents/room-utils", () => ({
  deleteDocumentRoom: vi.fn(),
}));

vi.mock("@/app/documents/sanitize-content", () => ({
  sanitizeAndLog: vi.fn((content: string | null) => content),
}));

import { generateText } from "@repo/ai/server";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { Status } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { documentService } from "@/app/documents/document-service";
import { documentVersionService } from "@/app/documents/document-version-service";
import { documentMergeService } from "@/app/documents/merge-service";
import { deleteDocumentRoom } from "@/app/documents/room-utils";
import { sanitizeAndLog } from "@/app/documents/sanitize-content";
import { documentTemplatesService } from "@/app/templates/service";

const mockWithDbTx = (withDb as unknown as { tx: Mock }).tx;
const mockFindByIdSimple = documentService.findByIdSimple as Mock;
const mockGetLatest = documentVersionService.getLatest as Mock;
const mockFindOrgTemplate = documentTemplatesService.findOrgTemplate as Mock;
const mockDeleteDocumentRoom = deleteDocumentRoom as Mock;
const mockSanitizeAndLog = sanitizeAndLog as Mock;
const mockGenerateText = generateText as Mock;

function mockTx(tx: Record<string, unknown>) {
  mockWithDbTx.mockImplementation(
    async (fn: (tx: Record<string, unknown>) => unknown) => fn(tx)
  );
}

function makeDocument(overrides?: Record<string, unknown>) {
  return {
    id: "doc-primary",
    organizationId: "org-1",
    projectId: "proj-1",
    type: DocumentType.Prd,
    slug: "primary-slug",
    title: "Primary Document",
    status: DocumentStatus.Draft,
    latestVersion: 1,
    workstreamId: null,
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    fileName: null,
    priority: Priority.Medium,
    createdById: "user-1",
    tokenUsage: null,
    targetRepo: null,
    targetBranch: null,
    templateForType: null,
    sortOrder: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const PRIMARY_DOC = makeDocument({
  id: "doc-primary",
  slug: "primary-slug",
  type: DocumentType.Prd,
});

const SECONDARY_DOC = makeDocument({
  id: "doc-secondary",
  slug: "secondary-slug",
  type: DocumentType.Prd,
});

const MERGE_ARGS = ["doc-primary", "doc-secondary", "org-1", "user-1"] as const;

function setupHappyPath(overrides?: {
  primaryDoc?: ReturnType<typeof makeDocument> | null;
  secondaryDoc?: ReturnType<typeof makeDocument> | null;
  refreshedPrimaryDoc?: ReturnType<typeof makeDocument> | null;
  primaryContent?: string;
  secondaryContent?: string;
  mergedText?: string;
  latestVersion?: number;
}) {
  const {
    primaryDoc = PRIMARY_DOC,
    secondaryDoc = SECONDARY_DOC,
    refreshedPrimaryDoc = PRIMARY_DOC,
    primaryContent = "primary content",
    secondaryContent = "secondary content",
    mergedText = "merged content",
    latestVersion = 1,
  } = overrides ?? {};

  mockFindByIdSimple
    .mockResolvedValueOnce(primaryDoc)
    .mockResolvedValueOnce(secondaryDoc)
    .mockResolvedValueOnce(refreshedPrimaryDoc);
  mockGetLatest
    .mockResolvedValueOnce({ content: primaryContent })
    .mockResolvedValueOnce({ content: secondaryContent });
  mockFindOrgTemplate.mockResolvedValueOnce(null);
  mockGenerateText.mockResolvedValueOnce({ text: mergedText });
  mockTx({
    documentDetail: {
      findUnique: vi.fn().mockResolvedValue({ latestVersion }),
      update: vi.fn(),
    },
    documentVersion: { create: vi.fn() },
    artifact: { delete: vi.fn() },
  });
  mockDeleteDocumentRoom.mockResolvedValueOnce(undefined);
}

describe("documentMergeService.merge", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSanitizeAndLog.mockImplementation((content: string | null) => content);
  });

  it("returns NotFound when the primary document does not exist", async () => {
    mockFindByIdSimple
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(SECONDARY_DOC);

    const result = await documentMergeService.merge(...MERGE_ARGS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(Status.NotFound);
    }
  });

  it("returns NotFound when the secondary document does not exist", async () => {
    mockFindByIdSimple
      .mockResolvedValueOnce(PRIMARY_DOC)
      .mockResolvedValueOnce(null);

    const result = await documentMergeService.merge(...MERGE_ARGS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(Status.NotFound);
    }
  });

  it("throws when documents are in different projects", async () => {
    mockFindByIdSimple
      .mockResolvedValueOnce(PRIMARY_DOC)
      .mockResolvedValueOnce(
        makeDocument({ id: "doc-secondary", projectId: "proj-2" })
      );

    await expect(documentMergeService.merge(...MERGE_ARGS)).rejects.toThrow(
      "Artifacts must be in the same project"
    );
  });

  it("throws when primary document has no projectId", async () => {
    mockFindByIdSimple
      .mockResolvedValueOnce(
        makeDocument({ id: "doc-primary", projectId: null })
      )
      .mockResolvedValueOnce(SECONDARY_DOC);

    await expect(documentMergeService.merge(...MERGE_ARGS)).rejects.toThrow(
      "Artifacts must be in the same project"
    );
  });

  it("throws when primary document is a TEMPLATE type", async () => {
    mockFindByIdSimple
      .mockResolvedValueOnce(
        makeDocument({ id: "doc-primary", type: DocumentType.Template })
      )
      .mockResolvedValueOnce(SECONDARY_DOC);

    await expect(documentMergeService.merge(...MERGE_ARGS)).rejects.toThrow(
      "Cannot merge TEMPLATE artifacts"
    );
  });

  it("throws when secondary document is a TEMPLATE type", async () => {
    mockFindByIdSimple
      .mockResolvedValueOnce(PRIMARY_DOC)
      .mockResolvedValueOnce(
        makeDocument({ id: "doc-secondary", type: DocumentType.Template })
      );

    await expect(documentMergeService.merge(...MERGE_ARGS)).rejects.toThrow(
      "Cannot merge TEMPLATE artifacts"
    );
  });

  it("throws when the LLM returns empty content", async () => {
    mockFindByIdSimple
      .mockResolvedValueOnce(PRIMARY_DOC)
      .mockResolvedValueOnce(SECONDARY_DOC);
    mockGetLatest
      .mockResolvedValueOnce({ content: "some content" })
      .mockResolvedValueOnce({ content: "some content" });
    mockFindOrgTemplate.mockResolvedValue(null);
    mockGenerateText.mockResolvedValue({ text: "   " });

    await expect(documentMergeService.merge(...MERGE_ARGS)).rejects.toThrow(
      "LLM returned empty merged content"
    );
  });

  it("throws before calling the LLM when combined content exceeds the token budget", async () => {
    // ~200k estimated tokens (>4 chars/token heuristic) overflows the input
    // budget, which must fail loudly rather than let the provider truncate.
    const oversizedContent = "a".repeat(800_000);
    mockFindByIdSimple
      .mockResolvedValueOnce(PRIMARY_DOC)
      .mockResolvedValueOnce(SECONDARY_DOC);
    mockGetLatest
      .mockResolvedValueOnce({ content: oversizedContent })
      .mockResolvedValueOnce({ content: oversizedContent });
    mockFindOrgTemplate.mockResolvedValue(null);

    await expect(documentMergeService.merge(...MERGE_ARGS)).rejects.toThrow(
      "Documents too large to merge"
    );
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("calls generateText with system prompt and both document contents", async () => {
    setupHappyPath({
      primaryContent: "primary content",
      secondaryContent: "secondary content",
    });

    await documentMergeService.merge(...MERGE_ARGS);

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("document merging assistant"),
        messages: [
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("primary content"),
          }),
        ],
        maxOutputTokens: 4096,
        // Pinned to 0 so the faithfulness-critical merge is deterministic
        // rather than running at the provider default (~1.0).
        temperature: 0,
      })
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining("secondary content"),
          }),
        ],
      })
    );
  });

  it("fetches a template when the two documents have different types", async () => {
    const primaryImpPlan = makeDocument({
      id: "doc-primary",
      type: DocumentType.ImplementationPlan,
    });
    const secondaryPrd = makeDocument({
      id: "doc-secondary",
      type: DocumentType.Prd,
    });
    const templateDoc = makeDocument({ id: "doc-template" });

    mockFindByIdSimple
      .mockResolvedValueOnce(primaryImpPlan)
      .mockResolvedValueOnce(secondaryPrd)
      .mockResolvedValueOnce(primaryImpPlan);
    mockGetLatest
      .mockResolvedValueOnce({ content: "primary content" })
      .mockResolvedValueOnce({ content: "secondary content" })
      .mockResolvedValueOnce({ content: "template content" });
    mockFindOrgTemplate.mockResolvedValue(templateDoc);
    mockGenerateText.mockResolvedValue({ text: "merged content" });
    mockTx({
      documentDetail: {
        findUnique: vi.fn().mockResolvedValue({ latestVersion: 2 }),
        update: vi.fn(),
      },
      documentVersion: { create: vi.fn() },
      artifact: { delete: vi.fn() },
    });
    mockDeleteDocumentRoom.mockResolvedValue(undefined);

    await documentMergeService.merge(...MERGE_ARGS);

    expect(mockFindOrgTemplate).toHaveBeenCalledWith(
      "org-1",
      DocumentType.ImplementationPlan
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining("template content"),
          }),
        ],
      })
    );
  });

  it("does not fetch a template when documents have the same type", async () => {
    setupHappyPath();

    await documentMergeService.merge(...MERGE_ARGS);

    expect(mockFindOrgTemplate).not.toHaveBeenCalled();
  });

  it("returns NotFound when the primary detail row is missing during the transaction", async () => {
    mockFindByIdSimple
      .mockResolvedValueOnce(PRIMARY_DOC)
      .mockResolvedValueOnce(SECONDARY_DOC);
    mockGetLatest
      .mockResolvedValueOnce({ content: "primary content" })
      .mockResolvedValueOnce({ content: "secondary content" });
    mockFindOrgTemplate.mockResolvedValue(null);
    mockGenerateText.mockResolvedValue({ text: "merged content" });
    mockTx({
      documentDetail: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await documentMergeService.merge(...MERGE_ARGS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(Status.NotFound);
    }
    expect(mockDeleteDocumentRoom).not.toHaveBeenCalled();
  });

  it("saves a new version on the primary and deletes the secondary artifact in the transaction", async () => {
    const txDocumentDetailFindUnique = vi
      .fn()
      .mockResolvedValue({ latestVersion: 3 });
    const txDocumentDetailUpdate = vi.fn();
    const txDocumentVersionCreate = vi.fn();
    const txArtifactDelete = vi.fn();

    setupHappyPath({ latestVersion: 3 });
    // Override the tx with named mocks for assertion
    mockTx({
      documentDetail: {
        findUnique: txDocumentDetailFindUnique,
        update: txDocumentDetailUpdate,
      },
      documentVersion: { create: txDocumentVersionCreate },
      artifact: { delete: txArtifactDelete },
    });

    await documentMergeService.merge(...MERGE_ARGS);

    expect(txDocumentVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          documentId: "doc-primary",
          version: 4,
          content: "merged content",
          createdById: "user-1",
        }),
      })
    );
    expect(txDocumentDetailUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { artifactId: "doc-primary" },
        data: { latestVersion: 4 },
      })
    );
    expect(txArtifactDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "doc-secondary", organizationId: "org-1" },
      })
    );
  });

  it("calls deleteDocumentRoom for the secondary slug after a successful transaction", async () => {
    setupHappyPath();

    await documentMergeService.merge(...MERGE_ARGS);

    expect(mockDeleteDocumentRoom).toHaveBeenCalledWith(
      "org-1",
      "secondary-slug"
    );
  });

  it("returns NotFound when the primary document is missing after the successful transaction", async () => {
    setupHappyPath({ refreshedPrimaryDoc: null });

    const result = await documentMergeService.merge(...MERGE_ARGS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(Status.NotFound);
    }
  });

  it("returns the updated primary document on success", async () => {
    const updatedDoc = makeDocument({
      id: "doc-primary",
      title: "Updated Primary",
    });
    setupHappyPath({ refreshedPrimaryDoc: updatedDoc });

    const result = await documentMergeService.merge(...MERGE_ARGS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(updatedDoc);
    }
  });

  it("escapes XML closing tags in document content before passing to LLM prompt", async () => {
    setupHappyPath({
      primaryContent: "primary with </tag> content",
      secondaryContent: "secondary with </other> content",
    });

    await documentMergeService.merge(...MERGE_ARGS);

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining("primary with &lt;/tag> content"),
          }),
        ],
      })
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining(
              "secondary with &lt;/other> content"
            ),
          }),
        ],
      })
    );
    // Original unescaped sequences must not appear in the prompt
    expect(mockGenerateText).not.toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining("</tag>"),
          }),
        ],
      })
    );
  });

  it("calls findByIdSimple with organizationId for both primary and secondary document lookups", async () => {
    setupHappyPath();

    await documentMergeService.merge(...MERGE_ARGS);

    expect(mockFindByIdSimple).toHaveBeenCalledWith("doc-primary", "org-1");
    expect(mockFindByIdSimple).toHaveBeenCalledWith("doc-secondary", "org-1");
  });

  it("sanitizes the merged content before writing to the database", async () => {
    const txDocumentVersionCreate = vi.fn();

    mockFindByIdSimple
      .mockResolvedValueOnce(PRIMARY_DOC)
      .mockResolvedValueOnce(SECONDARY_DOC)
      .mockResolvedValueOnce(PRIMARY_DOC);
    mockGetLatest
      .mockResolvedValueOnce({ content: "primary content" })
      .mockResolvedValueOnce({ content: "secondary content" });
    mockFindOrgTemplate.mockResolvedValue(null);
    mockGenerateText.mockResolvedValue({
      text: "<script>alert(1)</script>merged",
    });
    mockSanitizeAndLog.mockReturnValueOnce("sanitized merged");
    mockTx({
      documentDetail: {
        findUnique: vi.fn().mockResolvedValue({ latestVersion: 1 }),
        update: vi.fn(),
      },
      documentVersion: { create: txDocumentVersionCreate },
      artifact: { delete: vi.fn() },
    });
    mockDeleteDocumentRoom.mockResolvedValue(undefined);

    await documentMergeService.merge(...MERGE_ARGS);

    expect(mockSanitizeAndLog).toHaveBeenCalledWith(
      "<script>alert(1)</script>merged",
      "doc-primary"
    );
    expect(txDocumentVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: "sanitized merged" }),
      })
    );
  });
});
