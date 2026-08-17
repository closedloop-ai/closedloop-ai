import {
  buildInlineAttachmentMarkdownImage,
  buildInlineAttachmentRef,
  IMAGE_MIME_TYPES,
  MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS,
} from "@repo/api/src/types/attachment.js";
import { Priority } from "@repo/api/src/types/common.js";
import {
  CreateDocumentErrorCode,
  DocumentType,
  IssueStatus,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGES,
  RepositoryRole,
  SnapshotSource,
} from "@repo/api/src/types/document.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ZodType, z } from "zod";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import { registerCreateDocument } from "../tools/create-document.js";
import { createToolHarnessWithMock } from "./fixtures/tool-harness.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}>;

function createToolHarness(apiClient: ApiClient): {
  handler: ToolHandler;
  registeredOutputSchema: Record<string, ZodType>;
  registeredSchema: Record<string, ZodType>;
} {
  const { handler, registerTool } = createToolHarnessWithMock(
    registerCreateDocument,
    apiClient
  );
  const config = registerTool.mock.calls[0]?.[1] as {
    inputSchema: Record<string, ZodType>;
    outputSchema: Record<string, ZodType>;
  };
  return {
    handler,
    registeredOutputSchema: config.outputSchema,
    registeredSchema: config.inputSchema,
  };
}

const BASE_INPUT = {
  title: "My Feature",
  type: DocumentType.Feature,
  content: "Initial content",
};
const ATTACHMENT_ID = "attachment-1";
const ATTACHMENT_REF = buildInlineAttachmentRef(ATTACHMENT_ID);
const VALID_INLINE_IMAGE = {
  altText: "System diagram",
  dataBase64: "VEhJU19JU19USEVfSU1BR0U=",
  filename: "diagram.png",
  mimeType: IMAGE_MIME_TYPES[1],
  placeholder: "[[diagram]]",
};
const VALID_DUE_DATE = "2026-07-24T05:00:00.000Z";

describe("create-document MCP tool", () => {
  const apiClient = { post: vi.fn() } as unknown as ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      slug: "FEA-1",
      type: DocumentType.Feature,
    });
  });

  it("registers optional fields and inline image schemas", () => {
    const { registeredOutputSchema, registeredSchema } =
      createToolHarness(apiClient);
    expect(registeredSchema).toHaveProperty("assigneeId");
    expect(registeredSchema).toHaveProperty("approverId");
    expect(registeredSchema).toHaveProperty("priority");
    expect(registeredSchema).toHaveProperty("dueDate");
    expect(registeredSchema).toHaveProperty("fileName");
    expect(registeredSchema).toHaveProperty("status");
    expect(registeredSchema).toHaveProperty("repositorySelection");
    expect(registeredSchema).toHaveProperty("inlineImages");
    expect(registeredOutputSchema).toHaveProperty("dueDate");
    expect(registeredOutputSchema).toHaveProperty("inlineImages");
  });

  it("validates create-document inline image input boundaries", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const inlineImagesSchema = registeredSchema.inlineImages;
    expect(inlineImagesSchema.safeParse([VALID_INLINE_IMAGE]).success).toBe(
      true
    );
    expect(
      inlineImagesSchema.safeParse(
        Array.from({ length: MAX_CREATE_DOCUMENT_INLINE_IMAGES }, () => ({
          ...VALID_INLINE_IMAGE,
        }))
      ).success
    ).toBe(true);
    expect(
      inlineImagesSchema.safeParse(
        Array.from({ length: MAX_CREATE_DOCUMENT_INLINE_IMAGES + 1 }, () => ({
          ...VALID_INLINE_IMAGE,
        }))
      ).success
    ).toBe(false);
    expect(
      inlineImagesSchema.safeParse([{ ...VALID_INLINE_IMAGE, placeholder: "" }])
        .success
    ).toBe(false);
    expect(
      inlineImagesSchema.safeParse([
        {
          ...VALID_INLINE_IMAGE,
          placeholder: "x".repeat(
            MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS + 1
          ),
        },
      ]).success
    ).toBe(false);
    expect(
      inlineImagesSchema.safeParse([{ ...VALID_INLINE_IMAGE, filename: "" }])
        .success
    ).toBe(false);
    expect(
      inlineImagesSchema.safeParse([
        {
          ...VALID_INLINE_IMAGE,
          filename: "x".repeat(
            MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS + 1
          ),
        },
      ]).success
    ).toBe(false);
    expect(
      inlineImagesSchema.safeParse([{ ...VALID_INLINE_IMAGE, dataBase64: "" }])
        .success
    ).toBe(false);
    expect(
      inlineImagesSchema.safeParse([
        {
          ...VALID_INLINE_IMAGE,
          dataBase64: "x".repeat(MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS + 1),
        },
      ]).success
    ).toBe(false);
    expect(
      inlineImagesSchema.safeParse([
        {
          ...VALID_INLINE_IMAGE,
          altText: "x".repeat(
            MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS + 1
          ),
        },
      ]).success
    ).toBe(false);
    expect(
      inlineImagesSchema.safeParse([
        { ...VALID_INLINE_IMAGE, mimeType: "image/bmp" },
      ]).success
    ).toBe(false);
  });

  it("forwards assigneeId to the POST body", async () => {
    const userId = "019c2991-0bce-76bc-bc7e-a4750929f668";
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, assigneeId: userId });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ assigneeId: userId })
    );
  });

  it("forwards approverId to the POST body", async () => {
    const userId = "019c2991-0bce-76bc-bc7e-a4750929f668";
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, approverId: userId });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ approverId: userId })
    );
  });

  it("forwards priority to the POST body", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, priority: Priority.High });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ priority: Priority.High })
    );
  });

  it("forwards dueDate to the POST body", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, dueDate: VALID_DUE_DATE });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ dueDate: VALID_DUE_DATE })
    );
  });

  it("forwards null dueDate to the POST body when explicitly supplied", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, dueDate: null });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ dueDate: null })
    );
  });

  it("forwards fileName to the POST body", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, fileName: "my-feature.md" });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ fileName: "my-feature.md" })
    );
  });

  it("forwards repositorySelection to the POST body", async () => {
    const repoSelection = { primary: { fullName: "org/repo" } };
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, repositorySelection: repoSelection });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ repositorySelection: repoSelection })
    );
  });

  it("sends TRIAGE status for Features when status is omitted", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, type: DocumentType.Feature });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ status: IssueStatus.Triage })
    );
  });

  it("omits inlineImages from the POST body when callers provide no images", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, type: DocumentType.Feature });

    let calledBody = (apiClient.post as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Record<string, unknown>;
    expect(calledBody).not.toHaveProperty("inlineImages");

    vi.clearAllMocks();
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      slug: "FEA-1",
      type: DocumentType.Feature,
    });
    await handler({
      ...BASE_INPUT,
      inlineImages: [],
      type: DocumentType.Feature,
    });

    calledBody = (apiClient.post as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Record<string, unknown>;
    expect(calledBody).not.toHaveProperty("inlineImages");
    expect(calledBody).toHaveProperty("status", IssueStatus.Triage);
  });

  it("forwards non-empty inlineImages to the POST body", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({
      ...BASE_INPUT,
      inlineImages: [VALID_INLINE_IMAGE],
      type: DocumentType.Feature,
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({
        inlineImages: [VALID_INLINE_IMAGE],
        status: IssueStatus.Triage,
      })
    );
  });

  it("sends explicit status for Features instead of TRIAGE default", async () => {
    const { handler } = createToolHarness(apiClient);

    await handler({
      ...BASE_INPUT,
      type: DocumentType.Feature,
      status: IssueStatus.Backlog,
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/documents",
      expect.objectContaining({ status: IssueStatus.Backlog })
    );
  });

  it("sends no status field for non-Feature types when status is omitted", async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      slug: "PRD-1",
      type: DocumentType.Prd,
    });
    const { handler } = createToolHarness(apiClient);

    await handler({ ...BASE_INPUT, type: DocumentType.Prd });

    const calledBody = (apiClient.post as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Record<string, unknown>;
    expect(calledBody).not.toHaveProperty("status");
  });

  it("marks projectId as required in the inputSchema", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    // The MCP create-document tool is intentionally scoped to project-bound
    // artifacts, so its schema requires projectId and does not tell the LLM the
    // field is optional (FEA-2886). The API's createDocumentValidator now only
    // requires projectId for the project-bound subtypes (PRD/PLAN/FEATURE) and
    // allows org-level Documents/Templates without one (FEA-4345); the MCP tool
    // keeps projectId required regardless. (notFoundResponse("Project") only
    // applies to the separate case where a projectId is supplied but doesn't
    // resolve.)
    expect(registeredSchema.projectId.safeParse(undefined).success).toBe(false);
    expect(registeredSchema.projectId.safeParse("PRO-7").success).toBe(true);
  });

  it("scopes the type schema to project-bound subtypes and rejects org-level DOC/TEMPLATE (FEA-4345)", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    // The tool requires a projectId, so it only creates project-bound
    // artifacts. Org-level DOC/TEMPLATE (created via the web New-Document flow)
    // are rejected here rather than reaching the API with a spurious project
    // (TEMPLATE + project 500s; DOC would be stored under a project).
    expect(registeredSchema.type.safeParse(DocumentType.Prd).success).toBe(
      true
    );
    expect(
      registeredSchema.type.safeParse(DocumentType.ImplementationPlan).success
    ).toBe(true);
    expect(registeredSchema.type.safeParse(DocumentType.Feature).success).toBe(
      true
    );
    expect(registeredSchema.type.safeParse(DocumentType.Doc).success).toBe(
      false
    );
    expect(registeredSchema.type.safeParse(DocumentType.Template).success).toBe(
      false
    );
  });

  it("rejects a non-UUID string for assigneeId via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const result = registeredSchema.assigneeId.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID string for approverId via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const result = registeredSchema.approverId.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
  });

  it("accepts ISO date and timezone-qualified datetime dueDate values", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    expect(registeredSchema.dueDate.safeParse("2026-07-24").success).toBe(true);
    expect(registeredSchema.dueDate.safeParse(VALID_DUE_DATE).success).toBe(
      true
    );
  });

  it("rejects invalid dueDate strings via schema validation", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const result = registeredSchema.dueDate.safeParse("not-a-date");
    expect(result.success).toBe(false);
  });

  it("accepts a valid repositorySelection shape with fullName and optional branch", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const repoSchema = registeredSchema.repositorySelection;
    const result = repoSchema.safeParse({
      primary: { fullName: "org/repo", branch: "main" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a repositorySelection missing primary.fullName", () => {
    const { registeredSchema } = createToolHarness(apiClient);
    const repoSchema = registeredSchema.repositorySelection;
    const result = repoSchema.safeParse({ primary: {} });
    expect(result.success).toBe(false);
  });

  it("preserves envelope-shaped no-image API responses in structuredContent", async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        assignee: {
          email: "owner@example.com",
          firstName: "Owner",
          id: "user-1",
          lastName: null,
        },
        assigneeId: "user-1",
        createdAt: "2026-07-20T12:00:00.000Z",
        createdById: "user-1",
        dueDate: VALID_DUE_DATE,
        fileName: null,
        id: "doc-1",
        latestVersion: 1,
        organizationId: "org-1",
        priority: Priority.Medium,
        projectId: "project-1",
        repositorySnapshot: {
          createdAt: "2026-07-20T12:00:00.000Z",
          repositories: [
            {
              branch: "main",
              fullName: "closedloop-ai/symphony-alpha",
              position: 0,
              role: RepositoryRole.Primary,
            },
          ],
          source: SnapshotSource.LoopSelection,
        },
        slug: "FEA-42",
        sortOrder: 10,
        status: IssueStatus.Triage,
        templateForType: null,
        title: "My Feature",
        type: DocumentType.Feature,
        updatedAt: "2026-07-20T12:01:00.000Z",
      },
    });
    const { handler, registeredOutputSchema } = createToolHarness(apiClient);

    const result = await handler({ ...BASE_INPUT, type: DocumentType.Feature });

    const textPayload = JSON.parse(result.content[0].text);
    expect(result.structuredContent).toEqual(textPayload);
    expect(
      z
        .object(registeredOutputSchema)
        .strict()
        .safeParse(result.structuredContent).success
    ).toBe(true);
    expect(textPayload).toMatchObject({
      assignee: {
        email: "owner@example.com",
        firstName: "Owner",
        id: "user-1",
        lastName: null,
      },
      id: "doc-1",
      dueDate: VALID_DUE_DATE,
      priority: Priority.Medium,
      repositorySnapshot: {
        repositories: [
          {
            branch: "main",
            fullName: "closedloop-ai/symphony-alpha",
            position: 0,
            role: RepositoryRole.Primary,
          },
        ],
        source: SnapshotSource.LoopSelection,
      },
      slug: "FEA-42",
      type: DocumentType.Feature,
    });
    expect(textPayload).not.toHaveProperty("inlineImages");
    expect(textPayload).not.toHaveProperty("versionContent");
  });

  it("returns sanitized structuredContent and mirrored text for inline image creates", async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      assignee: {
        email: "owner@example.com",
        id: "user-1",
        storageKey: "attachments/org/doc/assignee-secret",
      },
      createdBy: {
        email: "creator@example.com",
        id: "user-2",
        previewUrl: "https://s3.example.com/creator-preview",
      },
      dataBase64: "VEhJU19UT1BfTEVWRUxfTVVTVF9OT1RfTEVBSw==",
      id: "doc-1",
      key: "attachments/org/doc/top-level-key",
      previewUrl: "https://s3.example.com/top-level-preview",
      slug: "FEA-42",
      storageKey: "attachments/org/doc/top-level-storage-key",
      type: DocumentType.Feature,
      versionContent: `Initial ![System diagram](${ATTACHMENT_REF})`,
      repositorySnapshot: {
        repositories: [
          {
            fullName: "closedloop-ai/symphony-alpha",
            key: "attachments/org/doc/repository-entry-key",
            role: RepositoryRole.Primary,
          },
        ],
        source: SnapshotSource.LoopSelection,
        storageKey: "attachments/org/doc/repository-snapshot-key",
      },
      inlineImages: [
        {
          attachment: {
            id: ATTACHMENT_ID,
            key: "attachments/org/doc/attachment-key",
            previewUrl: "https://s3.example.com/attachment-preview",
            storageKey: "attachments/org/doc/attachment-storage-key",
          },
          attachmentId: ATTACHMENT_ID,
          attachmentRef: ATTACHMENT_REF,
          dataBase64: "VEhJU19NVVNUX05PVF9MRUFL",
          key: "attachments/org/doc/inline-key",
          markdownImage: `![System diagram](${ATTACHMENT_REF})`,
          placeholder: "[[diagram]]",
          storageKey: "attachments/org/doc/inline-storage-key",
        },
      ],
    });
    const { handler, registeredOutputSchema } = createToolHarness(apiClient);

    const result = await handler({
      ...BASE_INPUT,
      content: "Initial [[diagram]]",
      inlineImages: [VALID_INLINE_IMAGE],
      type: DocumentType.Feature,
    });

    const textPayload = JSON.parse(result.content[0].text);
    expect(result.structuredContent).toEqual(textPayload);
    expect(
      z
        .object(registeredOutputSchema)
        .strict()
        .safeParse(result.structuredContent).success
    ).toBe(true);
    expect(textPayload).toMatchObject({
      assignee: {
        email: "owner@example.com",
        id: "user-1",
      },
      createdBy: {
        email: "creator@example.com",
        id: "user-2",
      },
      id: "doc-1",
      repositorySnapshot: {
        repositories: [
          {
            fullName: "closedloop-ai/symphony-alpha",
            role: RepositoryRole.Primary,
          },
        ],
        source: SnapshotSource.LoopSelection,
      },
      slug: "FEA-42",
      type: DocumentType.Feature,
      versionContent: `Initial ![System diagram](${ATTACHMENT_REF})`,
      inlineImages: [
        {
          attachmentId: ATTACHMENT_ID,
          attachmentRef: ATTACHMENT_REF,
          markdownImage: `![System diagram](${ATTACHMENT_REF})`,
          placeholder: "[[diagram]]",
        },
      ],
    });
    const serializedResult = JSON.stringify(result);
    expect(textPayload.inlineImages[0].attachmentRef).toBe(ATTACHMENT_REF);
    expect(serializedResult).not.toContain("dataBase64");
    expect(serializedResult).not.toContain("VEhJU19NVVNUX05PVF9MRUFL");
    expect(serializedResult).not.toContain(
      "VEhJU19UT1BfTEVWRUxfTVVTVF9OT1RfTEVBSw=="
    );
    expect(serializedResult).not.toContain("top-level-key");
    expect(serializedResult).not.toContain("top-level-storage-key");
    expect(serializedResult).not.toContain("top-level-preview");
    expect(serializedResult).not.toContain("inline-key");
    expect(serializedResult).not.toContain("inline-storage-key");
    expect(serializedResult).not.toContain("attachment-key");
    expect(serializedResult).not.toContain("attachment-storage-key");
    expect(serializedResult).not.toContain("attachment-preview");
    expect(serializedResult).not.toContain("assignee-secret");
    expect(serializedResult).not.toContain("creator-preview");
    expect(serializedResult).not.toContain("repository-entry-key");
    expect(serializedResult).not.toContain("repository-snapshot-key");
  });

  it("accepts generated Markdown images with escaped brackets in alt text", async () => {
    const markdownImage = buildInlineAttachmentMarkdownImage(
      ATTACHMENT_REF,
      "System ] diagram",
      "diagram.png"
    );
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      inlineImages: [
        {
          attachmentId: ATTACHMENT_ID,
          attachmentRef: ATTACHMENT_REF,
          markdownImage,
          placeholder: "[[diagram]]",
        },
      ],
      slug: "FEA-42",
      type: DocumentType.Feature,
      versionContent: `Initial ${markdownImage}`,
    });
    const { handler } = createToolHarness(apiClient);

    const result = await handler({
      ...BASE_INPUT,
      content: "Initial [[diagram]]",
      inlineImages: [
        {
          ...VALID_INLINE_IMAGE,
          altText: "System ] diagram",
        },
      ],
      type: DocumentType.Feature,
    });

    const textPayload = JSON.parse(result.content[0].text);
    expect(result.isError).toBeUndefined();
    expect(textPayload.inlineImages[0]).toMatchObject({
      attachmentId: ATTACHMENT_ID,
      attachmentRef: ATTACHMENT_REF,
      markdownImage,
      placeholder: "[[diagram]]",
    });
  });

  it("synthesizes missing attachmentRef from a valid attachment id", async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      inlineImages: [
        {
          attachmentId: ATTACHMENT_ID,
          markdownImage: "![System diagram](attachment://attachment-1)",
          placeholder: "[[diagram]]",
        },
      ],
      slug: "FEA-42",
      type: DocumentType.Feature,
    });
    const { handler } = createToolHarness(apiClient);

    const result = await handler({
      ...BASE_INPUT,
      content: "Initial [[diagram]]",
      inlineImages: [VALID_INLINE_IMAGE],
      type: DocumentType.Feature,
    });

    const textPayload = JSON.parse(result.content[0].text);
    expect(result.isError).toBeUndefined();
    expect(textPayload.inlineImages[0]).toMatchObject({
      attachmentId: ATTACHMENT_ID,
      attachmentRef: ATTACHMENT_REF,
      markdownImage: "![System diagram](attachment://attachment-1)",
      placeholder: "[[diagram]]",
    });
  });

  it("rebuilds a bare attachmentRef prefix from a valid attachment id", async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      inlineImages: [
        {
          attachmentId: ATTACHMENT_ID,
          attachmentRef: "attachment://",
          markdownImage: "![System diagram](attachment://attachment-1)",
          placeholder: "[[diagram]]",
        },
      ],
      slug: "FEA-42",
      type: DocumentType.Feature,
    });
    const { handler } = createToolHarness(apiClient);

    const result = await handler({
      ...BASE_INPUT,
      content: "Initial [[diagram]]",
      inlineImages: [VALID_INLINE_IMAGE],
      type: DocumentType.Feature,
    });

    const textPayload = JSON.parse(result.content[0].text);
    expect(result.isError).toBeUndefined();
    expect(textPayload.inlineImages[0]).toMatchObject({
      attachmentId: ATTACHMENT_ID,
      attachmentRef: ATTACHMENT_REF,
      markdownImage: "![System diagram](attachment://attachment-1)",
      placeholder: "[[diagram]]",
    });
  });

  it("rejects inline image Markdown that does not reference the resolved attachment ref", async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      inlineImages: [
        {
          attachmentId: ATTACHMENT_ID,
          attachmentRef: "attachment://",
          markdownImage: "![System diagram](attachment://)",
          placeholder: "[[diagram]]",
        },
      ],
      slug: "FEA-42",
      type: DocumentType.Feature,
    });
    const { handler } = createToolHarness(apiClient);

    const result = await handler({
      ...BASE_INPUT,
      content: "Initial [[diagram]]",
      inlineImages: [VALID_INLINE_IMAGE],
      type: DocumentType.Feature,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain(
      "API response inlineImages.markdownImage does not reference inlineImages.attachmentRef"
    );
    expect(result.content[0].text).not.toContain("attachment://");
  });

  it("rejects inline image Markdown when the resolved ref is outside the image destination", async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      inlineImages: [
        {
          attachmentId: ATTACHMENT_ID,
          attachmentRef: ATTACHMENT_REF,
          markdownImage:
            "![System diagram](https://example.invalid) attachment://attachment-1",
          placeholder: "[[diagram]]",
        },
      ],
      slug: "FEA-42",
      type: DocumentType.Feature,
    });
    const { handler } = createToolHarness(apiClient);

    const result = await handler({
      ...BASE_INPUT,
      content: "Initial [[diagram]]",
      inlineImages: [VALID_INLINE_IMAGE],
      type: DocumentType.Feature,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain(
      "API response inlineImages.markdownImage does not reference inlineImages.attachmentRef"
    );
    expect(result.content[0].text).not.toContain("https://example.invalid");
  });

  it("rejects malformed inline image API rows instead of returning empty refs", async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      inlineImages: [
        {
          markdownImage: "![System diagram](attachment://)",
          placeholder: "[[diagram]]",
        },
      ],
      slug: "FEA-42",
      type: DocumentType.Feature,
    });
    const { handler } = createToolHarness(apiClient);

    const result = await handler({
      ...BASE_INPUT,
      content: "Initial [[diagram]]",
      inlineImages: [VALID_INLINE_IMAGE],
      type: DocumentType.Feature,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain(
      "API response missing inlineImages.attachmentId"
    );
    expect(result.content[0].text).not.toContain("attachment://");
  });

  it("surfaces API failures through isError without sensitive details", async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockRejectedValue(
      new McpApiError(
        "Inline image placeholder must appear in content with dataBase64 VEhJU19NVVNUX05PVF9MRUFL, storageKey attachments/org/doc/message-secret-key, signed URL https://s3.example.com/object?X-Amz-Signature=secret",
        {
          code: CreateDocumentErrorCode.MissingInlineImagePlaceholder,
          details: {
            dataBase64: "VEhJU19NVVNUX05PVF9MRUFL",
            storageKey: "attachments/org/doc/secret-key",
          },
          status: 400,
        }
      )
    );
    const { handler } = createToolHarness(apiClient);

    const result = await handler({
      ...BASE_INPUT,
      content: "Initial content",
      inlineImages: [VALID_INLINE_IMAGE],
      type: DocumentType.Feature,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain(
      "Inline image placeholder must appear in content"
    );
    expect(result.content[0].text).not.toContain("dataBase64");
    expect(result.content[0].text).not.toContain("VEhJU19NVVNUX05PVF9MRUFL");
    expect(result.content[0].text).not.toContain(
      "attachments/org/doc/secret-key"
    );
    expect(result.content[0].text).not.toContain(
      "attachments/org/doc/message-secret-key"
    );
    expect(result.content[0].text).not.toContain("X-Amz-Signature");
    expect(result.content[0].text).not.toContain("s3.example.com");
  });
});
